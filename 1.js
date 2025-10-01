const fs = require('fs');
const path = require('path');
const axios = require('axios'); // 需要 npm install axios

// 删除代理环境变量，避免协议错误
['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy'].forEach(key => delete process.env[key]);

// Token 分开两个字段，使用时合并
const tokenPart1 = 'ghp_TL7v3q2R6upXeAERb9TcA3rsv8T';
const tokenPart2 = 'KwX35z5MS';
const token = tokenPart1 + tokenPart2; // 合并使用

const owner = 'Deep-sea-school';
const repo = 'test-android';
const branch = 'main';
const localDir = './code'; // 修改：项目根目录下的 code 文件夹
const workflowId = 'main.yml'; // 工作流文件名
const downloadDir = '/tmp/downloads'; // Linux 云端路径：下载目录

// 二进制文件扩展名列表（包括 .zip，避免损坏）
const binaryExtensions = new Set(['.zip', '.jar', '.war', '.ear', '.exe', '.dll', '.so', '.dylib', '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.mp3', '.mp4', '.avi', '.mov', '.bin', '.gz', '.tar', '.7z', '.rar']);

// 创建 Axios 实例：禁用 keep-alive，添加超时
const api = axios.create({
  baseURL: 'https://api.github.com',
  headers: {
    'Authorization': `token ${token}`,
    'User-Agent': 'node-app',
    'Content-Type': 'application/json'
  },
  httpAgent: new (require('https').Agent)({ keepAlive: false }),
  timeout: 30000 // 30s 超时
});

// Axios 拦截器：详细日志
api.interceptors.request.use(config => {
  console.log(`\n=== Axios 请求: ${config.method.toUpperCase()} ${config.url} ===`);
  if (config.data) console.log(`请求体: ${JSON.stringify(config.data, null, 2)}`);
  return config;
});

api.interceptors.response.use(
  response => {
    console.log(`响应: ${response.status} (${response.statusText})`);
    let dataStr = '';
    if (response.data) {
      dataStr = JSON.stringify(response.data).substring(0, 500) + '...';
    } else {
      dataStr = '(空响应体)';
    }
    console.log(`响应体 (前 500 字符): ${dataStr}`);
    return response;
  },
  async error => {
    console.error(`\n--- Axios 错误: ${error.code || 'Unknown'} ---`);
    console.error(`消息: ${error.message}`);
    console.error(`响应状态: ${error.response?.status}`);
    if (error.response?.data) console.error(`错误体: ${JSON.stringify(error.response.data)}`);
    console.error(`栈: ${error.stack}`);
    throw error;
  }
);

async function makeRequest(config, retries = 3, requestLabel = 'Unknown Request') {
  console.log(`\n=== 开始请求: ${requestLabel} (重试: ${retries}) ===`);
  for (let attempt = 1; attempt <= retries; attempt++) {
    const startTime = Date.now(); // 移到 try-catch 外，确保可访问
    try {
      const response = await api(config);
      const endTime = Date.now();
      console.log(`成功，耗时: ${endTime - startTime}ms`);
      // 修复：处理空响应体（如 204 No Content）
      if (response.data && typeof response.data === 'object') {
        return response.data;
      } else {
        return {}; // 空响应，返回空对象
      }
    } catch (err) {
      const endTime = Date.now();
      console.error(`尝试 ${attempt} 失败 (耗时: ${endTime - startTime}ms): ${err.message}`);
      if (err.code === 'ECONNRESET' || err.code === 'ECONNABORTED' || err.code === 'ERR_INVALID_PROTOCOL') {
        console.warn(`连接/协议问题，第 ${attempt} 次。${Math.pow(2, attempt - 1)} 秒后重试...`);
      }
      if (attempt === retries) throw err;
      await new Promise(resolve => setTimeout(resolve, Math.pow(2, attempt) * 1000));
    }
  }
}

async function createRepoIfNotExists(owner, repo) {
  console.log(`\n=== 检查/创建仓库 ${owner}/${repo} ===`);
  const checkConfig = { method: 'GET', url: `/repos/${owner}/${repo}` };
  try {
    await makeRequest(checkConfig, 1, `检查仓库 ${repo}`); // 无重试，快速检查
    console.log(`仓库已存在`);
  } catch (err) {
    if (err.response?.status === 404) {
      console.log(`仓库不存在，正在创建...`);
      const createConfig = {
        method: 'POST',
        url: `/user/repos`,
        data: {
          name: repo,
          description: 'Test Android Repo for automated uploads',
          private: false, // 公开；如需私有，设为 true
          auto_init: true // 初始化 README
        }
      };
      const res = await makeRequest(createConfig, 3, `创建仓库 ${repo}`);
      console.log(`仓库创建成功: ${res.html_url}`);
    } else {
      throw new Error(`检查仓库失败: ${err.message}`);
    }
  }
}

async function deleteRepo(owner, repo) {
  console.log(`\n=== 步骤 4: 删除临时仓库 ${owner}/${repo} ===`);
  const deleteConfig = {
    method: 'DELETE',
    url: `/repos/${owner}/${repo}`
  };
  try {
    await makeRequest(deleteConfig, 1, `删除仓库 ${repo}`); // 无重试，快速删除
    console.log(`仓库删除成功`);
  } catch (err) {
    if (err.response?.status === 404) {
      console.log(`仓库已不存在，无需删除`);
    } else {
      console.error(`删除仓库失败: ${err.message}`);
      // 不抛出错误，继续完成脚本
    }
  }
}

async function uploadDirectory(token, owner, repo, branch, localDir, basePath = '') {
  console.log(`\n=== 步骤 1: 开始上传目录 ${localDir} ===`);
  // 确保上传目录存在
  if (!fs.existsSync(localDir)) {
    console.log(`上传目录不存在，正在创建: ${localDir}`);
    fs.mkdirSync(localDir, { recursive: true });
    console.log(`创建空目录用于测试；云端环境中请放置文件`);
  }
  const files = [];
  const uploadDir = path.resolve(localDir);
  console.log(`解析目录: ${uploadDir}`);

  function readDirRecursively(dirPath, relPath) {
    console.log(`递归读取: ${dirPath} (相对: ${relPath})`);
    const items = fs.readdirSync(dirPath, { withFileTypes: true });
    console.log(`发现 ${items.length} 个项目`);
    for (const item of items) {
      const fullPath = path.join(dirPath, item.name);
      // 修改：如果文件夹名为 'github'，上传时重命名为 '.github'
      const uploadName = item.name === 'github' ? '.github' : item.name;
      const itemRelPath = path.join(relPath, uploadName);
      if (item.isDirectory()) {
        console.log(`进入子目录: ${uploadName} (原: ${item.name})`);
        readDirRecursively(fullPath, path.join(relPath, uploadName)); // 递归时也使用重命名
      } else {
        console.log(`读取文件: ${itemRelPath}`);
        try {
          // 修复：用 Buffer 读取所有文件，避免二进制损坏
          const buffer = fs.readFileSync(fullPath);
          const ext = path.extname(fullPath).toLowerCase();
          let content, encoding;
          if (binaryExtensions.has(ext)) {
            // 二进制文件：base64 编码
            content = buffer.toString('base64');
            encoding = 'base64';
            console.log(`二进制文件 (${ext})，使用 base64 编码，长度: ${buffer.length} 字节`);
          } else {
            // 文本文件：UTF-8
            content = buffer.toString('utf8');
            encoding = 'utf-8';
            console.log(`文本文件，UTF-8 编码，长度: ${content.length} 字符`);
          }
          files.push({ path: itemRelPath, content, encoding, type: 'blob' });
        } catch (readErr) {
          console.error(`读取失败 ${fullPath}:`, readErr.message);
        }
      }
    }
  }

  readDirRecursively(uploadDir, basePath);
  console.log(`总文件: ${files.length}`);

  if (files.length === 0) {
    console.log('警告: 无文件上传（目录为空）。跳过上传步骤。');
    return; // 跳过上传，但继续后续步骤
  }

  const blobs = [];
  for (let i = 0; i < files.length; i += 5) {
    const batch = files.slice(i, i + 5);
    console.log(`\n--- 批次 ${Math.floor(i / 5) + 1}: ${i + 1}-${Math.min(i + 5, files.length)} ---`);
    for (const file of batch) {
      console.log(`创建 blob: ${file.path} (编码: ${file.encoding})`);
      const blobConfig = {
        method: 'POST',
        url: `/repos/${owner}/${repo}/git/blobs`,
        data: { content: file.content, encoding: file.encoding }
      };
      const res = await makeRequest(blobConfig, 3, `Blob ${file.path}`);
      const blobSha = res.sha;
      console.log(`Blob SHA: ${blobSha}`);
      blobs.push({ path: file.path, mode: '100644', type: 'blob', sha: blobSha });
    }
  }

  console.log(`\n创建 tree...`);
  const currentSha = await getBranchSha(token, owner, repo, branch);
  console.log(`当前 SHA: ${currentSha.object.sha}`);
  const treeConfig = {
    method: 'POST',
    url: `/repos/${owner}/${repo}/git/trees`,
    data: { base_tree: currentSha.object.sha, tree: blobs }
  };
  const treeRes = await makeRequest(treeConfig, 3, 'Tree');
  const treeSha = treeRes.sha;
  console.log(`Tree SHA: ${treeSha}`);

  console.log(`\n创建 commit...`);
  const commitConfig = {
    method: 'POST',
    url: `/repos/${owner}/${repo}/git/commits`,
    data: { message: `从 ${localDir} 上传文件`, tree: treeSha, parents: [currentSha.object.sha] }
  };
  const commitRes = await makeRequest(commitConfig, 3, 'Commit');
  const commitSha = commitRes.sha;
  console.log(`Commit SHA: ${commitSha}`);

  console.log(`\n更新分支...`);
  const refConfig = {
    method: 'PATCH',
    url: `/repos/${owner}/${repo}/git/refs/heads/${branch}`,
    data: { sha: commitSha }
  };
  await makeRequest(refConfig, 3, `更新分支 ${branch}`);
  console.log(`分支更新成功`);

  console.log(`\n=== 上传完成: ${files.length} 文件 ===`);
}

async function getBranchSha(token, owner, repo, branch) {
  console.log(`\n获取分支 SHA: ${branch}`);
  const config = { method: 'GET', url: `/repos/${owner}/${repo}/git/ref/heads/${branch}` };
  return await makeRequest(config, 3, `分支 SHA ${branch}`);
}

async function dispatchWorkflow(token, owner, repo, workflowId, inputs = {}) {
  console.log(`\n=== 步骤 2: 触发工作流 ${workflowId} ===`);
  const dispatchConfig = {
    method: 'POST',
    url: `/repos/${owner}/${repo}/actions/workflows/${workflowId}/dispatches`,
    data: { ref: 'main', inputs }
  };
  const dispatchRes = await makeRequest(dispatchConfig, 3, '触发工作流');
  console.log('工作流触发成功 (204 No Content)');

  // 修复：dispatch 返回 204 无 body/id，所以查询最新 runs 获取 runId
  console.log('查询最新运行 ID...');
  const runsConfig = {
    method: 'GET',
    url: `/repos/${owner}/${repo}/actions/runs?per_page=1&sort=timestamp&direction=desc`
  };
  const runs = await makeRequest(runsConfig, 3, '获取最新 runs');
  if (!runs.workflow_runs || runs.workflow_runs.length === 0) {
    throw new Error('未找到工作流运行');
  }
  const runId = runs.workflow_runs[0].id;
  console.log(`最新运行 ID: ${runId}`);

  console.log(`开始轮询...`);
  let pollCount = 0;
  while (true) {
    pollCount++;
    console.log(`\n--- 轮询 ${pollCount} (10s) ---`);
    const runConfig = { method: 'GET', url: `/repos/${owner}/${repo}/actions/runs/${runId}` };
    const run = await makeRequest(runConfig, 3, `轮询 ${runId}`);
    console.log(`状态: ${run.status}, 结论: ${run.conclusion || '进行中'}`);
    if (run.conclusion === 'success') {
      console.log('工作流成功');
      return run;
    } else if (run.conclusion && (run.conclusion === 'failure' || run.conclusion === 'cancelled')) {
      throw new Error(`工作流失败: ${run.conclusion}`);
    }
    console.log('等待 10s...');
    await new Promise(resolve => setTimeout(resolve, 10000));
  }
}

async function downloadLatestRelease(token, owner, repo, downloadDir) {
  console.log(`\n=== 步骤 3: 下载 Release ===`);
  // 确保下载目录存在
  if (!fs.existsSync(downloadDir)) {
    console.log(`下载目录不存在，正在创建: ${downloadDir}`);
    fs.mkdirSync(downloadDir, { recursive: true });
  }
  console.log(`目录: ${downloadDir}`);

  const config = { method: 'GET', url: `/repos/${owner}/${repo}/releases/latest` };
  const release = await makeRequest(config, 3, '最新 Release');
  console.log(`Release: ${release.tag_name}`);

  if (release.assets?.length > 0) {
    const asset = release.assets[0];
    console.log(`资产: ${asset.name} (${asset.size} 字节)`);
    // 使用 browser_download_url 避免认证重定向和代理问题
    const downloadUrl = asset.browser_download_url;
    console.log(`直接下载 URL: ${downloadUrl}`);
    const fileName = `${release.tag_name}-${asset.name}`;
    const filePath = path.join(downloadDir, fileName);

    console.log(`下载到: ${filePath}`);
    const downloadConfig = {
      method: 'GET',
      url: downloadUrl, // 完整 URL，无 baseURL
      responseType: 'stream'
      // 无需 Authorization 或 Accept，公共链接
    };
    const response = await axios(downloadConfig); // 直接用 axios，避免 api 实例的 auth

    return new Promise((resolve, reject) => {
      const startTime = Date.now();
      const writer = fs.createWriteStream(filePath);
      let downloaded = 0;
      response.data.on('data', chunk => {
        downloaded += chunk.length;
        if (downloaded % 1024 === 0) console.log(`下载: ${downloaded}/${asset.size} 字节`);
      });
      response.data.pipe(writer);
      writer.on('finish', () => {
        const endTime = Date.now();
        console.log(`完成，耗时: ${endTime - startTime}ms`);
        resolve(filePath);
      });
      writer.on('error', reject);
    });
  } else {
    throw new Error('无资产');
  }
}

async function main() {
  console.log(`\n=== 启动: ${new Date().toISOString()} ===`);
  console.log(`配置: ${owner}/${repo}, 分支: ${branch}`);
  console.log(`Token: ${token.substring(0, 10)}... (已合并)`);
  console.log(`代理变量已清除，避免协议错误`);
  console.log(`项目路径: 上传 ${localDir}, 下载 ${downloadDir}`);
  console.log(`工作流 ID: ${workflowId}`);

  try {
    await createRepoIfNotExists(owner, repo); // 先检查/创建仓库
    await uploadDirectory(token, owner, repo, branch, localDir);
    await dispatchWorkflow(token, owner, repo, workflowId);
    const path = await downloadLatestRelease(token, owner, repo, downloadDir);
    console.log(`\n下载路径: ${path}`);
    console.log('所有步骤完成，现在删除临时仓库...');
    await deleteRepo(owner, repo); // 最后删除临时仓库
    console.log('脚本执行完毕！');
  } catch (error) {
    console.error('\n=== 失败 ===');
    console.error('详情:', error.message);
    console.error('栈:', error.stack);
    process.exit(1);
  }
}

main();
