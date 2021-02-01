'use strict'

const gateway = require('../index')
const { P2cBalancer } = require('load-balancers')

const targets = [
    'http://172.18.254.95:7001',
    'http://172.18.254.95:7002',
    'http://172.18.254.95:7003',
    'http://172.18.254.95:7004',
    'http://172.18.254.95:7005',
    'http://172.18.1.50:7001',
    'http://172.18.1.50:7002',
    'http://172.18.1.50:7003',
    'http://172.18.1.50:7004',
    'http://172.18.1.50:7005',
]
const balancer = new P2cBalancer(targets.length);

gateway({
    routes: [{
        proxyHandler: (req, res, url, proxy, proxyOpts) => {
            proxyOpts.base = targets[balancer.pick()];
            return proxy(req, res, url, proxyOpts);
        },
        prefix: '/gateway',
    }]
}).start(38880).then(() => console.log('API Gateway Service Start !'));