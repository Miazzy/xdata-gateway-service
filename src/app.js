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

/** target 改为 rest_service_name  */
let targets = [];
let xtargets = [];
let estargets = [];

let balancer = null;
let xbalancer = null;
let esbalancer = null;

const middlewareNacos = async(req, res, next) => {
    const nacosConfig = config().nacos;
    const ipAddress = getIpAddress()
    const client = new nacos.NacosNamingClient(nacosConfig);
    await client.ready();
    await client.registerInstance(nacosConfig.serviceName, {
        ip: ipAddress,
        port,
    });
    client.subscribe(nacosConfig.restServiceName, hosts => {
        targets = hosts; // 选出健康的targets;
        balancer = new P2cBalancer(targets.length);
    });
    client.subscribe(nacosConfig.xmysqlServiceName, hosts => {
        xtargets = hosts; // 选出健康的targets;
        xbalancer = new P2cBalancer(xtargets.length);
    });
    client.subscribe(nacosConfig.elasticSearchServiceName, hosts => {
        estargets = hosts; // 选出健康的targets;
        esbalancer = new P2cBalancer(estargets.length);
    });
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

// mock service
service.get('/**/*', (req, res) => res.send({ code: '099', err: 'token err.', success: false })).start(parseInt(defaultTarget.split(':')[2])).then(() => console.log('Public Service Start!'));

// gateway service
gateway({
    middlewares: [
        // first acquire request IP
        (req, res, next) => {
            req.ip = requestIp.getClientIp(req)
            return next()
        },
        // second enable rate limiter
        rateLimit({
            windowMs: 1 * 60 * 1000, // 1 minutes
            max: 1000000, // limit each IP to 1000 requests per windowMs
            handler: (req, res) => res.send({ code: '099', err: '您的请求速度太快了，请稍后尝试!', success: false }, 429)
        }),
        middleware503to404,
        require('cors')(),
        require('helmet')(),
    ],
    routes: [{
        proxyHandler: async(req, res, url, proxy, proxyOpts) => {
            // 使用负载均衡算法，选取一个API服务地址，配置到proxy.Opts.base中
            // const target = xtargets[xbalancer.pick()];
            const baseURL = 'http://172.18.6.202:30012'; //主数据后端服务，目前只提供IP地址的后端URL
            console.log(`base url: `, baseURL);
            proxyOpts.base = baseURL;
            console.log('backend service: ' + proxyOpts.base + url);
            breaker.fire([req, res, url, proxy, proxyOpts]);
        },
        prefix: '/gateway-mdm',
    }, {
        proxyHandler: async(req, res, url, proxy, proxyOpts) => {
            // 使用负载均衡算法，选取一个API服务地址，配置到proxy.Opts.base中
            const target = xtargets[xbalancer.pick()];
            const baseURL = 'http://' + target.ip + ':' + target.port;
            console.log(baseURL);
            res.setHeader('x-header-base', baseURL);
            // 对此API服务地址，就行健康检查(/_health)，如果不正常，则重新选取API服务地址，并将此API地址，从服务列表中移除。如果正常，则继续执行

            // 检查请求频率，如果过高，加入黑名单，黑名单失效后，移除黑名单

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
        proxyHandler: async(req, res, url, proxy, proxyOpts) => {
            // 使用负载均衡算法，选取一个API服务地址，配置到proxy.Opts.base中
            const target = xtargets[xbalancer.pick()];
            const baseURL = 'http://' + target.ip + ':' + target.port;
            console.log(baseURL);
            res.setHeader('x-header-base', baseURL);
            // 对此API服务地址，就行健康检查(/_health)，如果不正常，则重新选取API服务地址，并将此API地址，从服务列表中移除。如果正常，则继续执行

            // 检查请求频率，如果过高，加入黑名单，黑名单失效后，移除黑名单

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
        proxyHandler: async(req, res, url, proxy, proxyOpts) => {
            // 使用负载均衡算法，选取一个API服务地址，配置到proxy.Opts.base中
            const target = estargets[esbalancer.pick()];
            const baseURL = 'http://' + target.ip + ':' + target.port;
            console.log(baseURL);
            res.setHeader('x-header-base', baseURL);
            // 对此API服务地址，就行健康检查(/_health)，如果不正常，则重新选取API服务地址，并将此API地址，从服务列表中移除。如果正常，则继续执行

            // 检查请求频率，如果过高，加入黑名单，黑名单失效后，移除黑名单

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
        proxyHandler: async(req, res, url, proxy, proxyOpts) => {
            // 使用负载均衡算法，选取一个API服务地址，配置到proxy.Opts.base中
            const target = targets[balancer.pick()];
            const baseURL = 'http://' + target.ip + ':' + target.port;
            console.log(baseURL);
            res.setHeader('x-header-base', baseURL);
            // 对此API服务地址，就行健康检查(/_health)，如果不正常，则重新选取API服务地址，并将此API地址，从服务列表中移除。如果正常，则继续执行

            // 检查请求频率，如果过高，加入黑名单，黑名单失效后，移除黑名单

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