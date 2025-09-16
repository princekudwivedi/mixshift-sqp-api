const { S3Client, PutObjectCommand, HeadObjectCommand, GetObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { region, bucket, credentials, basePrefix } = require('../config/s3.config');

const s3 = new S3Client({ region, credentials });

function buildKey(parts = []) {
    return [basePrefix, ...parts.filter(Boolean)].join('/');
}

async function uploadJson(parts, filename, json) {
    const Key = buildKey([...parts, filename]);
    const Body = Buffer.from(JSON.stringify(json));
    const ContentType = 'application/json';
    let attempt = 0;
    const maxAttempts = 3;
    while (true) {
        try {
            await s3.send(new PutObjectCommand({ Bucket: bucket, Key, Body, ContentType }));
            return { bucket, key: Key, url: `s3://${bucket}/${Key}` };
        } catch (err) {
            attempt++;
            if (attempt >= maxAttempts) throw err;
            await new Promise(r => setTimeout(r, 200 * attempt));
        }
    }
}

async function exists(parts, filename) {
    const Key = buildKey([...parts, filename]);
    try {
        await s3.send(new HeadObjectCommand({ Bucket: bucket, Key }));
        return true;
    } catch (_) {
        return false;
    }
}

async function deleteObject(parts, filename) {
    const Key = buildKey([...parts, filename]);
    await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key }));
}

module.exports = { uploadJson, exists, deleteObject, buildKey };


