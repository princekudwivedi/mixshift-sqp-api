const path = require('path');
require('dotenv').config({ path: path.resolve(process.cwd(), '.env') });

function env(name, def) {
    if (process.env[name] !== undefined && process.env[name] !== '') return process.env[name];
    return def;
}

module.exports = {
    db: {
        host: env('DB_HOST', null),
        port: Number(env('DB_PORT', null)),
        user: env('DB_USER', null),
        password: env('DB_PASS', null),
        database: env('DB_NAME', null),
        waitForConnections: true,
        connectionLimit: 10,
        queueLimit: 0,
    },
    developer: {
        ClientId: env('DEVELOPER_CLIENT_ID', null),
        ClientSecret: env('DEVELOPER_CLIENT_SECERET', null),
    },
    aws: {
        accessKeyId: env('AWS_ACCESS_KEY_ID', null),
        secretAccessKey: env('AWS_SECRET_ACCESS_KEY', null),
        roleArn: env('AWS_ROLE_ARN', null),
        stsRegion: env('AWS_STS_REGION', null),
    },
    amazonSpApi: {
        baseUrl: env('AMAZON_SP_API_BASE_URL', null),
        asiaBaseUrl: env('AMAZON_SP_API_ASIA_BASE_URL', null),
        europeBaseUrl: env('AMAZON_SP_API_EUROPE_BASE_URL', null),
    },
    tables: {
        sqpCronDetails: env('TBL_SQP_CRON_DETAILS', 'sqp_cron_details'),
        cronLogs: env('TBL_SQP_CRON_LOGS', 'sqp_cron_logs'),
        reportData: env('TBL_SQP_REPORT_DATA', 'sqp_report_data'),
        sellerAsinList: env('TBL_SELLER_ASIN_LIST', 'seller_ASIN_list'),
        seller: env('TBL_SELLER', 'seller'),
        cronDetails: env('TBL_CRON_DETAILS', 'cron_details'),
        marketPlace: env('TBL_MARKET_PLACE', 'marketplace'),
        sellerMarketPlacesMapping: env('TBL_SELLER_MARKET_PLACES_MAPPING', 'seller_marketplaces_mapping'),

        // master schema tables
        users: env('TBL_USERS', 'users'),
        userDbMap: env('TBL_USER_DB_MAP', 'user_database_mapping'),
        userDbs: env('TBL_USER_DATABASES', 'user_databases'),
        timezones: env('TBL_TIMEZONES', 'timezones'),
        oauthTokens: env('TBL_MWS_OAUTH_TOKEN', 'tbl_mws_oauth_token'),
        mwsAccessKeys: env('TBL_MWS_ACCESS_KEYS', 'mws_access_keys'),
        stsTokens: env('TBL_SPAPI_STS_TOKEN', 'sp_api_sts'),
        sqpDownloadUrls: env('TBL_SQP_DOWNLOAD_URLS', 'sqp_download_urls'),
        sqpReportData: env('TBL_SQP_REPORT_DATA', 'sqp_report_data'),
        sqpMetrics3mo: env('TBL_SQP_METRICS_3MO', 'sqp_metrics_3mo')
    },
    logLevel: env('LOG_LEVEL', 'info'),
};


