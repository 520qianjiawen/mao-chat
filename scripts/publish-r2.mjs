#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import https from 'node:https';
import { fileURLToPath } from 'node:url';
import { S3Client, PutObjectCommand, ListObjectsV2Command, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

const R2_CONFIG = {
  accountId: process.env.R2_ACCOUNT_ID || 'aa52c619220f1e19d9eac366022c0478',
  token: process.env.R2_TOKEN || 'cfat_4bH0TbuvTHx6Vhor27fF1W75TWRq2psoYPrzzvK712c53842',
  accessKeyId: process.env.R2_ACCESS_KEY_ID || '59c14a13d8790a0d7d0dba90e5cbfce7',
  secretAccessKey: process.env.R2_SECRET_ACCESS_KEY || 'b85eda2bfe938efebcb580f7f554116011920de6e3ddaa17bed75f3f81d9fd2d',
  bucket: process.env.R2_BUCKET || 'software',
  publicDomain: process.env.R2_PUBLIC_DOMAIN || 'https://software.asg.li',
  prefix: 'mao-chat',
};

function uploadFileToR2(key, filePath, contentType) {
  return new Promise((resolve, reject) => {
    const stat = fs.statSync(filePath);
    const totalBytes = stat.size;
    let uploadedBytes = 0;

    const url = `https://api.cloudflare.com/client/v4/accounts/${R2_CONFIG.accountId}/r2/buckets/${R2_CONFIG.bucket}/objects/${encodeURI(key)}`;
    const headers = {
      'Authorization': `Bearer ${R2_CONFIG.token}`,
      'Content-Type': contentType || 'application/octet-stream',
      'Content-Length': String(totalBytes),
    };

    const req = https.request(url, {
      method: 'PUT',
      headers,
    }, (res) => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try {
            resolve(JSON.parse(body || '{}'));
          } catch {
            resolve({ raw: body });
          }
        } else {
          reject(new Error(`R2 upload failed [${res.statusCode}]: ${body}`));
        }
      });
    });

    req.on('error', reject);

    const stream = fs.createReadStream(filePath, { highWaterMark: 1024 * 1024 });
    stream.on('data', (chunk) => {
      uploadedBytes += chunk.length;
      const pct = ((uploadedBytes / totalBytes) * 100).toFixed(1);
      process.stdout.write(`\r⏳ 上传进度: ${pct}% (${(uploadedBytes / 1024 / 1024).toFixed(1)} MB / ${(totalBytes / 1024 / 1024).toFixed(1)} MB)`);
    });
    stream.on('error', (err) => {
      req.destroy(err);
      reject(err);
    });

    stream.pipe(req);
  });
}

function uploadToR2ViaRest(key, bufferOrStream, contentType, contentLength) {
  return new Promise((resolve, reject) => {
    const url = `https://api.cloudflare.com/client/v4/accounts/${R2_CONFIG.accountId}/r2/buckets/${R2_CONFIG.bucket}/objects/${key}`;
    const headers = {
      'Authorization': `Bearer ${R2_CONFIG.token}`,
      'Content-Type': contentType,
    };
    if (contentLength !== undefined) {
      headers['Content-Length'] = String(contentLength);
    }

    const req = https.request(url, {
      method: 'PUT',
      headers,
    }, (res) => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try {
            resolve(JSON.parse(body || '{}'));
          } catch {
            resolve({ raw: body });
          }
        } else {
          reject(new Error(`R2 upload failed [${res.statusCode}]: ${body}`));
        }
      });
    });

    req.on('error', reject);

    if (Buffer.isBuffer(bufferOrStream) || typeof bufferOrStream === 'string') {
      req.end(bufferOrStream);
    } else {
      bufferOrStream.pipe(req);
    }
  });
}

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
  const args = process.argv.slice(2);
  const manifestOnly = args.includes('--manifest-only') || args.includes('--only-manifest');

  for (const arg of args) {
    if (arg.startsWith('--access-key=')) R2_CONFIG.accessKeyId = arg.split('=')[1];
    if (arg.startsWith('--access-key-id=')) R2_CONFIG.accessKeyId = arg.split('=')[1];
    if (arg.startsWith('--secret-key=')) R2_CONFIG.secretAccessKey = arg.split('=')[1];
    if (arg.startsWith('--secret-access-key=')) R2_CONFIG.secretAccessKey = arg.split('=')[1];
    if (arg.startsWith('--token=')) R2_CONFIG.token = arg.split('=')[1];
  }

  const pkgJsonPath = path.join(rootDir, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
  const version = pkg.version;
  console.log(`\n🚀 准备发布 MAO Chat v${version} 到 Cloudflare R2...`);

  const outDir = path.join(rootDir, 'out');
  if (!fs.existsSync(outDir)) {
    console.error(`❌ 未找到 out 目录: ${outDir}，请先执行打包构建！`);
    process.exit(1);
  }

  // Find dmg files in out/
  const files = fs.readdirSync(outDir);
  const dmgFile = files.find(f => f.includes(version) && f.endsWith('.dmg'))
    || files.find(f => f.endsWith('.dmg'));

  if (!dmgFile) {
    console.error(`❌ 在 out/ 目录下未找到版本 ${version} 的 .dmg 安装包！`);
    console.error(`当前目录文件:`, files);
    process.exit(1);
  }

  const dmgPath = path.join(outDir, dmgFile);
  const stat = fs.statSync(dmgPath);
  console.log(`📦 找到安装包: ${dmgFile} (${(stat.size / 1024 / 1024).toFixed(1)} MB)`);

  console.log(`⏳ 正在计算 SHA-256 哈希值...`);
  const sha256 = await computeSha256(dmgPath);
  console.log(`🔑 SHA-256: ${sha256}`);

  const r2DmgKey = `${R2_CONFIG.prefix}/MAO-Chat-${version}-arm64.dmg`;
  const dmgPublicUrl = `${R2_CONFIG.publicDomain}/${r2DmgKey}`;

  if (!manifestOnly) {
    if (R2_CONFIG.accessKeyId && R2_CONFIG.secretAccessKey) {
      console.log(`\n📤 正在通过 S3 分块传输上传安装包 (${(stat.size / 1024 / 1024).toFixed(1)} MB) 到 R2: ${r2DmgKey} ...`);
      const s3 = new S3Client({
        region: 'auto',
        endpoint: `https://${R2_CONFIG.accountId}.r2.cloudflarestorage.com`,
        credentials: {
          accessKeyId: R2_CONFIG.accessKeyId,
          secretAccessKey: R2_CONFIG.secretAccessKey,
        },
      });

      const parallelUploads3 = new Upload({
        client: s3,
        params: {
          Bucket: R2_CONFIG.bucket,
          Key: r2DmgKey,
          Body: fs.createReadStream(dmgPath),
          ContentType: 'application/x-apple-diskimage',
        },
        partSize: 20 * 1024 * 1024,
        leavePartsOnError: false,
      });

      parallelUploads3.on('httpUploadProgress', (progress) => {
        if (progress.total) {
          const pct = ((progress.loaded / progress.total) * 100).toFixed(1);
          process.stdout.write(`\r⏳ 上传进度: ${pct}% (${(progress.loaded / 1024 / 1024).toFixed(1)} MB / ${(progress.total / 1024 / 1024).toFixed(1)} MB)`);
        }
      });

      await parallelUploads3.done();
      console.log(`\n✅ 安装包分块上传成功: ${dmgPublicUrl}`);
    } else {
      console.log(`\n⚠️  提示：Cloudflare 对 REST API 单次请求限制为 100MB。`);
      console.log(`大文件需要通过 S3 分块传输协议上传，您只需提供创建 R2 API 令牌时页面显示的两个字段：`);
      console.log(`1. 访问密钥 ID (Access Key ID)`);
      console.log(`2. 机密访问密钥 (Secret Access Key)`);
      console.log(`\n或者您也可以在 Cloudflare 控制台将本地安装包拖入 software 存储桶的 mao-chat/ 目录下：`);
      console.log(`本地安装包路径: ${dmgPath}`);
      console.log(`上传完成后执行: node scripts/publish-r2.mjs --manifest-only\n`);
      process.exit(1);
    }
  }

  // Prepare and upload manifest
  const manifest = {
    version,
    name: `MAO Chat ${version}`,
    pub_date: new Date().toISOString(),
    notes: `<h3>MAO Chat v${version} 更新说明</h3><ul><li>划词与截图翻译全新支持多模型聚合：同时支持系统翻译（Apple Translate 原生离线引擎）、智谱翻译（GLM-4-Flash 官方免费调用）与硅基流动翻译（Qwen2.5-7B 极速高并发）</li><li>独立品牌化系统翻译快捷指令：内置一键安装 MAO.Translate 快捷指令，提供30秒简易配置指引与快捷指令自动化授权提示</li><li>划词翻译窗口全面升级为 macOS 浅色毛玻璃精致质感，各模型卡片支持独立展开/折叠、耗时显示与复制朗读</li><li>提供直接快捷获取 Key 入口与行内快速配置，免除复杂操作</li></ul>`,
    files: {
      'darwin-arm64': {
        url: dmgPublicUrl,
        size: stat.size,
        sha256,
      },
      'darwin': {
        url: dmgPublicUrl,
        size: stat.size,
        sha256,
      },
    },
  };

  const manifestKey = `${R2_CONFIG.prefix}/latest-mac.json`;
  console.log(`📤 正在发布最新更新清单: ${manifestKey} ...`);
  const manifestBuffer = Buffer.from(JSON.stringify(manifest, null, 2), 'utf8');

  if (R2_CONFIG.accessKeyId && R2_CONFIG.secretAccessKey) {
    const s3 = new S3Client({
      region: 'auto',
      endpoint: `https://${R2_CONFIG.accountId}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: R2_CONFIG.accessKeyId,
        secretAccessKey: R2_CONFIG.secretAccessKey,
      },
    });
    await s3.send(new PutObjectCommand({
      Bucket: R2_CONFIG.bucket,
      Key: manifestKey,
      Body: manifestBuffer,
      ContentType: 'application/json; charset=utf-8',
    }));
  } else {
    await uploadToR2ViaRest(
      manifestKey,
      manifestBuffer,
      'application/json; charset=utf-8'
    );
  }

  const manifestUrl = `${R2_CONFIG.publicDomain}/${manifestKey}`;
  console.log(`🎉 发布成功！最新清单地址: ${manifestUrl}`);
  console.log(`客户端已能够通过清单检测到最新版本 v${version}！\n`);

  // Clean up older .pkg versions in R2 to save storage
  if (R2_CONFIG.accessKeyId && R2_CONFIG.secretAccessKey) {
    try {
      console.log(`🧹 正在检查并清理 R2 存储桶中的旧版本安装包...`);
      const s3 = new S3Client({
        region: 'auto',
        endpoint: `https://${R2_CONFIG.accountId}.r2.cloudflarestorage.com`,
        credentials: {
          accessKeyId: R2_CONFIG.accessKeyId,
          secretAccessKey: R2_CONFIG.secretAccessKey,
        },
      });
      const listRes = await s3.send(new ListObjectsV2Command({
        Bucket: R2_CONFIG.bucket,
        Prefix: `${R2_CONFIG.prefix}/`,
      }));

      let deletedCount = 0;
      for (const item of listRes.Contents || []) {
        if (!item.Key) continue;
        const isOldDmg = item.Key.endsWith('.dmg') && item.Key !== r2DmgKey;
        const isOldPkg = item.Key.endsWith('.pkg');
        if (isOldDmg || isOldPkg) {
          console.log(`🗑️  删除旧版本文件: ${item.Key} (${(item.Size / 1024 / 1024).toFixed(1)} MB)`);
          await s3.send(new DeleteObjectCommand({
            Bucket: R2_CONFIG.bucket,
            Key: item.Key,
          }));
          deletedCount++;
        }
      }
      if (deletedCount === 0) {
        console.log(`✨ 云端已处于最简状态，仅保留当前最新版 v${version}！\n`);
      } else {
        console.log(`✨ 旧版本清理完毕，共删除 ${deletedCount} 个旧版本安装包！\n`);
      }
    } catch (cleanErr) {
      console.warn(`⚠️  清理旧版本时出现非致命错误:`, cleanErr.message);
    }
  }
}

main().catch(err => {
  console.error(`❌ 发布失败:`, err);
  process.exit(1);
});
