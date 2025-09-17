require('dotenv').config();

module.exports = {
    region: process.env.AWS_STS_REGION || 'us-east-1',
    bucket: process.env.S3_BUCKET || 'your-bucket-name',
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID || '',
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || ''
    },
    basePrefix: process.env.S3_BASE_PREFIX || 'reports'
};


