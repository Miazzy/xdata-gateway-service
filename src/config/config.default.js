/* eslint valid-jsdoc: "off" */
/* eslint-disable indent */
/* eslint-disable eol-last */
'use strict';

/**
 * @param {AppInfo} appInfo app info
 */
module.exports = () => {

    const config = exports = {};
    const nacosIP = 'nacos.yunwisdom.club'; // nacos IP地址 const nacosIP = '172.18.1.51';
    const nacosList = [`${nacosIP}:30080`]; // const nacosList = [`${nacosIP}:8848`, `${nacosIP}:8849`, `${nacosIP}:8850`];

    config.nacos = {
        logger: console,
        serverList: nacosList,
        namespace: 'public',
        groupName: 'DEFAULT_GROUP',
        serviceName: 'xdata-gateway-service',
        restServiceName: 'xdata-rest-service',
        weworkServiceName: 'xdata-wework-service',
        xmysqlServiceName: 'xdata-xmysql-service',
        elasticSearchServiceName: 'xdata-elasticsearch-service',
    };

    return {
        ...config,
    };
};