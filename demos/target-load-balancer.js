'use strict'

const gateway = require('../index')
const { P2cBalancer } = require('load-balancers')

const targets = [
    'http://localhost:3000',
    'http://localhost:3001',
    'http://localhost:3002',
]
const balancer = new P2cBalancer(targets.length)

gateway({
    routes: [{
        proxyHandler: (req, res, url, proxy, proxyOpts) => {
            proxyOpts.base = targets[balancer.pick()]

            return proxy(req, res, url, proxyOpts)
        },
        prefix: '/balanced'
    }]
}).start(8080).then(() => console.log('API Gateway listening on 8080 port!'))

const service = require('restana')({})
service
    .get('/hello', (req, res) => res.send({ msg: 'Hello from service 1!' }))
    .start(3000).then(() => console.log('Public service listening on 3000 port!'))


const service1 = require('restana')({})
service1
    .get('/hello', (req, res) => res.send('Hello World!'))
    .start(3001).then(() => console.log('Public service listening on 3001 port!'))

const service2 = require('restana')({})
service2
    .get('/hello', (req, res) => res.send([]))
    .start(3002).then(() => console.log('Admin service listening on 3002 port!'))

// Usage: curl 'http://localhost:8080/balanced/get'