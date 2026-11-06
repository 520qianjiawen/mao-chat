#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

const R2_CONFIG = {
  accountId: process.env.R2_ACCOUNT_ID || 'aa52c619220f1e19d9eac366022c0478',
  accessKeyId: process.env.R2_ACCESS_KEY_ID || '59c14a13d8790a0d7d0dba90e5cbfce7',
  secretAccessKey: process.env.R2_SECRET_ACCESS_KEY || 'b85eda2bfe938efebcb580f7f554116011920de6e3ddaa17bed75f3f81d9fd2d',
  bucket: process.env.R2_BUCKET || 'software',
  publicDomain: process.env.R2_PUBLIC_DOMAIN || 'https://software.asg.li',
};

async function computeSha256(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', data => hash.update(data));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

async function main() {
  const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
  const sidecarVersion = pkg.sidecarVersion || '0.1.13';
  const prefix = `mao-chat/sidecars/v${sidecarVersion}`;

  const archivePath = path.join(rootDir, 'out', 'bundles', `sidecar-mac-v${sidecarVersion}.tar.zst`);
  if (!fs.existsSync(archivePath)) {
    console.error(`❌ 未找到 sidecar 归档文件: ${archivePath}`);
    process.exit(1);
  }

  const stat = fs.statSync(archivePath);
  console.log(`📦 正在准备上传 Sidecar 归档 (v${sidecarVersion}, ${(stat.size / 1024 / 1024).toFixed(1)} MB)...`);
  const sha256 = await computeSha256(archivePath);
  console.log(`🔑 SHA-256: ${sha256}`);

  // Create manifest
  const manifest = {
    version: sidecarVersion,
    bundles: [
      {
        sku: 'mac',
        version: sidecarVersion,
        sha256,
        size: stat.size,
        installedSize: 1459250897,
        parts: [
          {
            name: `sidecar-mac-v${sidecarVersion}.tar.zst`,
            size: stat.size,
            sha256,
          },
        ],
      },
    ],
  };

  const manifestPath = path.join(rootDir, 'out', 'bundles', 'manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
  console.log(`📄 已生成 manifest.json`);

  const s3 = new S3Client({
    region: 'auto',
    endpoint: `https://${R2_CONFIG.accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: R2_CONFIG.accessKeyId,
      secretAccessKey: R2_CONFIG.secretAccessKey,
    },
  });

  const archiveKey = `${prefix}/sidecar-mac-v${sidecarVersion}.tar.zst`;
  console.log(`\n📤 正在通过 S3 分块传输上传 Sidecar 到 R2: ${archiveKey} ...`);

  const parallelUpload = new Upload({
    client: s3,
    params: {
      Bucket: R2_CONFIG.bucket,
      Key: archiveKey,
      Body: fs.createReadStream(archivePath),
      ContentType: 'application/octet-stream',
    },
    partSize: 20 * 1024 * 1024,
    leavePartsOnError: false,
  });

  parallelUpload.on('httpUploadProgress', (progress) => {
    if (progress.total) {
      const pct = ((progress.loaded / progress.total) * 100).toFixed(1);
      process.stdout.write(`\r⏳ 上传进度: ${pct}% (${(progress.loaded / 1024 / 1024).toFixed(1)} MB / ${(progress.total / 1024 / 1024).toFixed(1)} MB)`);
    }
  });

  await parallelUpload.done();
  console.log(`\n✅ Sidecar 归档上传成功: ${R2_CONFIG.publicDomain}/${archiveKey}`);

  const manifestKey = `${prefix}/manifest.json`;
  console.log(`📤 正在上传 manifest.json 到 R2: ${manifestKey} ...`);
  await s3.send(new PutObjectCommand({
    Bucket: R2_CONFIG.bucket,
    Key: manifestKey,
    Body: Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'),
    ContentType: 'application/json; charset=utf-8',
  }));

  console.log(`🎉 发布成功！清单地址: ${R2_CONFIG.publicDomain}/${manifestKey}`);
}

main().catch(err => {
  console.error(`❌ 上传失败:`, err);
  process.exit(1);
});
