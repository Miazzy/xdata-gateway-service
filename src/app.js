'use strict'

/** 
    启动微服务可能导致mysql连接数超限，如下设置MySQL最大连接数
    1、查看最大连接数
    show variables like '%max_connections%';
    2、修改最大连接数
    set GLOBAL max_connections = 200;
 */
const gateway = require('../index');
const { P2cBalancer } = require('load-balancers');
const service = require('restana')({});
const onEnd = require('on-http-end');
const CircuitBreaker = require('opossum');
const rateLimit = require('express-rate-limit');
const requestIp = require('request-ip');
const nacos = require('nacos');
const os = require('os');
const config = require('./config/config.default');
const port = 3880;
const defaultTarget = 'http://localhost:3881';
const cache = require('memory-cache');


function getIpAddress() {
    var ifaces = os.networkInterfaces()
    for (var dev in ifaces) {
        let iface = ifaces[dev]
        for (let i = 0; i < iface.length; i++) {
            let { family, address, internal } = iface[i]
            if (family === 'IPv4' && address !== '127.0.0.1' && !internal) {
                return address
            }
        }
    }
}

/** target 目标服务IP地址+Port端口  */
let targets = [];
let xtargets = [];
let wxtargets = [];
let estargets = [];

let balancer = null;
let xbalancer = null;
let wxbalancer = null;
let esbalancer = null;

let nacosConfigClient = null;

const middlewareNacos = async(req, res, next) => {
    const nacosConfig = config().nacos;
    const ipAddress = getIpAddress()

    const client = new nacos.NacosNamingClient(nacosConfig); // 注册网关服务
    await client.ready();
    await client.registerInstance(nacosConfig.serviceName, {
        ip: ipAddress,
        port,
    });
    client.subscribe(nacosConfig.weworkServiceName, hosts => {
        targets = hosts; // 选出健康的targets;
        balancer = new P2cBalancer(targets.length);
    });
    client.subscribe(nacosConfig.weworkServiceName, hosts => {
        wxtargets = hosts; // 选出健康的targets;
        wxbalancer = new P2cBalancer(wxtargets.length);
    });
    client.subscribe(nacosConfig.xmysqlServiceName, hosts => {
        xtargets = hosts; // 选出健康的targets;
        xbalancer = new P2cBalancer(xtargets.length);
    });
    client.subscribe(nacosConfig.elasticSearchServiceName, hosts => {
        estargets = hosts; // 选出健康的targets;
        esbalancer = new P2cBalancer(estargets.length);
    });

    let configBalancer = new P2cBalancer(nacosConfig.serverList.length); //获取配置服务负载均衡器
    let nacosServerAddr = nacosConfig.serverList[configBalancer.pick()];

    console.log(`server addr: `, nacosServerAddr);
    nacosConfigClient = new nacos.NacosConfigClient({
        serverAddr: nacosServerAddr,
    }); // 配置服务 // for direct mode

    console.log(`serverAddr:`, nacosConfig.serverList);

}

middlewareNacos();

const options = {
    timeout: 6000, // If our function takes longer than "timeout", trigger a failure
    errorThresholdPercentage: 50, // When 50% of requests fail, trip the circuit
    resetTimeout: 3000 // After 30 seconds, try again.
}
const breaker = new CircuitBreaker(([req, res, url, proxy, proxyOpts]) => {
    return new Promise((resolve, reject) => {
        proxy(req, res, url, proxyOpts);
        onEnd(res, () => resolve()); // you can optionally evaluate response codes here...
    })
}, options);

const middleware503to404 = (req, res, next) => {
    const end = res.end
    res.end = function(...args) {
        if (res.statusCode === 503) {
            res.statusCode = 404
        }
        return end.apply(res, args)
    }

    return next()
};

breaker.fallback(([req, res], err) => {
    if (err.code === 'EOPENBREAKER') {
        res.send({
            code: '503',
            err: '服务器开小差了，请稍后尝试！',
            success: false,
            message: 'Upps, looks like we are under heavy load. Please try again in 30 seconds!'
        }, 503);
    }
});

console.log(defaultTarget.split(':')[2]);

/** mock service */
service.get('/**/*', (req, res) => res.send({ code: '099', err: 'token err.', success: false })).start(parseInt(defaultTarget.split(':')[2])).then(() => console.log('Public Service Start!'));

/** gateway service */
gateway({
    middlewares: [
        (req, res, next) => { // first acquire request IP
            req.ip = requestIp.getClientIp(req)
            return next()
        },
        rateLimit({ // second enable rate limiter
            windowMs: 1 * 60 * 1000, // 1 minutes
            max: 1000000, // limit each IP to 1000 requests per windowMs
            handler: (req, res) => res.send({ code: '099', err: '您的请求速度太快了，请稍后尝试!', success: false }, 429)
        }),
        middleware503to404,
        require('cors')(),
        require('helmet')(),
    ],
    routes: [{
        proxyHandler: async(req, res, url, proxy, proxyOpts) => { //获取配置服务配置信息
            console.log(`request: `, req.params.wild);

            let content = null;
            content = cache.get(req.params.wild);

            if (typeof content == 'undefined' || content == null) {
                content = await nacosConfigClient.getConfig(req.params.wild || 'system.admin.config', 'DEFAULT_GROUP');
                if (typeof content == 'undefined' || content == null) {
                    content = { code: 99, err: 'no config info found...', };
                }
                cache.put(req.params.wild, content, 3600);
            } else {
                console.info(`hit memory cache ... `, req.params.wild);
            }

            res.send(content, 200);
        },
        prefix: '/gateway-config',
    }, {
        proxyHandler: async(req, res, url, proxy, proxyOpts) => { //主数据代理接口(主)
            const baseURL = 'http://172.18.6.31:30013'; //主数据后端服务，目前只提供IP地址的后端URL
            console.log(`base url: `, baseURL);
            proxyOpts.base = baseURL;
            res.setHeader('x-header-base', baseURL);
            console.log('backend service: ' + proxyOpts.base + url);
            breaker.fire([req, res, url, proxy, proxyOpts]);
        },
        prefix: '/gateway-mdm',
    }, {
        proxyHandler: async(req, res, url, proxy, proxyOpts) => { //主数据代理接口(从)
            const baseURL = 'http://172.18.6.202:30012'; //主数据后端服务，目前只提供IP地址的后端URL
            console.log(`base url: `, baseURL);
            proxyOpts.base = baseURL;
            res.setHeader('x-header-base', baseURL);
            console.log('backend service: ' + proxyOpts.base + url);
            breaker.fire([req, res, url, proxy, proxyOpts]);
        },
        prefix: '/gateway-mdm-slave',
    }, {
        proxyHandler: async(req, res, url, proxy, proxyOpts) => { //数据库RestAPI接口
            const target = targets[balancer.pick()]; // 使用负载均衡算法，选取一个API服务地址，配置到proxy.Opts.base中
            const list = targets.map(item => item.ip);

            if (url.includes('/@')) {
                const ip = url.split('@')[1];
                list.includes(ip) ? target.ip = ip : null;
                url = url.replace(`/@${ip}@`, '');
                console.log(`target ip:`, target.ip);
            }

            const baseURL = 'http://' + target.ip + ':' + target.port;
            console.log(baseURL);
            res.setHeader('x-header-base', baseURL); // 对此API服务地址，就行健康检查(/_health)，如果不正常，则重新选取API服务地址，并将此API地址，从服务列表中移除。如果正常，则继续执行 // 检查请求频率，如果过高，加入黑名单，黑名单失效后，移除黑名单

            if (url && url.endsWith('hello') || false /** session or token 验证失效 */ ) {
                proxyOpts.base = defaultTarget;
            } else {
                proxyOpts.base = baseURL;
            }
            console.log('backend service: ' + proxyOpts.base + url);
            breaker.fire([req, res, url, proxy, proxyOpts]);
        },
        prefix: '/gateway-rest',
    }, {
        proxyHandler: async(req, res, url, proxy, proxyOpts) => { //数据库RestAPI接口
            const target = wxtargets[wxbalancer.pick()]; // 使用负载均衡算法，选取一个API服务地址，配置到proxy.Opts.base中
            const list = wxtargets.map(item => item.ip);

            if (url.includes('/@')) {
                const ip = url.split('@')[1];
                list.includes(ip) ? target.ip = ip : null;
                url = url.replace(`/@${ip}@`, '');
                console.log(`target ip:`, target.ip);
            }

            const baseURL = 'http://' + target.ip + ':' + target.port;
            console.log(baseURL);
            res.setHeader('x-header-base', baseURL);

            if (url && url.endsWith('hello') || false /** session or token 验证失效 */ ) {
                proxyOpts.base = defaultTarget;
            } else {
                proxyOpts.base = baseURL;
            }
            console.log('backend service: ' + proxyOpts.base + url);
            breaker.fire([req, res, url, proxy, proxyOpts]);
        },
        prefix: '/gateway-wework',
    }, {
        proxyHandler: async(req, res, url, proxy, proxyOpts) => { //数据库RestAPI接口
            const target = xtargets[xbalancer.pick()]; // 使用负载均衡算法，选取一个API服务地址，配置到proxy.Opts.base中
            const list = xtargets.map(item => item.ip); //如果URL路径含有/download或者/@{ip}@,则获取路径中的IP地址

            if (url.includes('/download?name=')) {
                const ip = url.split('@')[1];
                list.includes(ip) ? target.ip = ip : null;
                console.log(`target ip:`, target.ip);
            }
            if (url.includes('/@')) {
                const ip = url.split('@')[1];
                list.includes(ip) ? target.ip = ip : null;
                url = url.replace(`/@${ip}@`, '');
                console.log(`target ip:`, target.ip);
            }

            const baseURL = 'http://' + target.ip + ':' + target.port;
            console.log(baseURL);
            res.setHeader('x-header-base', baseURL); // 对此API服务地址，就行健康检查(/_health)，如果不正常，则重新选取API服务地址，并将此API地址，从服务列表中移除。如果正常，则继续执行 // 检查请求频率，如果过高，加入黑名单，黑名单失效后，移除黑名单

            if (url && url.endsWith('hello') || false /** session or token 验证失效 */ ) {
                proxyOpts.base = defaultTarget;
            } else {
                proxyOpts.base = baseURL;
            }
            console.log('backend service: ' + proxyOpts.base + url);
            breaker.fire([req, res, url, proxy, proxyOpts]);
        },
        prefix: '/gateway-xmysql',
    }, {
        proxyHandler: async(req, res, url, proxy, proxyOpts) => { //搜索引擎后端接口服务
            const target = estargets[esbalancer.pick()]; // 使用负载均衡算法，选取一个API服务地址，配置到proxy.Opts.base中
            const list = estargets.map(item => item.ip);

            if (url.includes('/@')) {
                const ip = url.split('@')[1];
                list.includes(ip) ? target.ip = ip : null;
                url = url.replace(`/@${ip}@`, '');
                console.log(`target ip:`, target.ip);
            }

            const baseURL = 'http://' + target.ip + ':' + target.port;
            console.log(baseURL);
            res.setHeader('x-header-base', baseURL); // 对此API服务地址，就行健康检查(/_health)，如果不正常，则重新选取API服务地址，并将此API地址，从服务列表中移除。如果正常，则继续执行 // 检查请求频率，如果过高，加入黑名单，黑名单失效后，移除黑名单

            if (url && url.endsWith('hello') || false /** session or token 验证失效 */ ) {
                proxyOpts.base = defaultTarget;
            } else {
                proxyOpts.base = baseURL;
            }
            console.log('backend service: ' + proxyOpts.base + url);
            breaker.fire([req, res, url, proxy, proxyOpts]);
        },
        prefix: '/gateway-elasticsearch',
    }, {
        proxyHandler: async(req, res, url, proxy, proxyOpts) => { //通用后端接口服务
            const target = targets[balancer.pick()]; // 使用负载均衡算法，选取一个API服务地址，配置到proxy.Opts.base中
            const list = targets.map(item => item.ip);

            if (url.includes('/@')) {
                const ip = url.split('@')[1];
                list.includes(ip) ? target.ip = ip : null;
                url = url.replace(`/@${ip}@`, '');
                console.log(`target ip:`, target.ip);
            }

            const baseURL = 'http://' + target.ip + ':' + target.port;
            console.log(baseURL);
            res.setHeader('x-header-base', baseURL); // 对此API服务地址，就行健康检查(/_health)，如果不正常，则重新选取API服务地址，并将此API地址，从服务列表中移除。如果正常，则继续执行 // 检查请求频率，如果过高，加入黑名单，黑名单失效后，移除黑名单

            if (url && url.endsWith('hello') || false /** session or token 验证失效 */ ) {
                proxyOpts.base = defaultTarget;
            } else {
                proxyOpts.base = baseURL;
            }
            console.log('backend service: ' + proxyOpts.base + url);
            breaker.fire([req, res, url, proxy, proxyOpts]);
        },
        prefix: '/gateway',
    }, ]
}).start(port).then(() => console.log('API Gateway Service Start !'));