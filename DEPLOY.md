# 寸序 (Inchi) 部署与 AI 接入指南

本文档介绍如何在**个人服务器（Linux VPS / 家用 NAS / Windows Server / 本地）**或 **Cloudflare Pages** 部署寸序，并接入大模型 API。

---

## 一、AI 大模型 API 接入

寸序采用工业级标准 **OpenAI 兼容协议**（`/chat/completions`），后端自动适配各种中转信封与推理型空响应。

### 1. 快速配置方式（.env）
在项目根目录创建 `.env` 文件（参考 `.env.example`）：

```bash
cp .env.example .env
```

填入你的 API Key 与配置：

```ini
# 【推荐：DeepSeek 官方】
LLM_API_KEY=sk-xxxxxx
LLM_BASE_URL=https://api.deepseek.com
LLM_MODEL=deepseek-chat

# 访问安全令牌（用于网页与 API 鉴权）
ADMIN_TOKEN=my-secret-token
PORT=8792
```

### 2. 常见 AI 供应商配置速查

| 供应商 | `LLM_BASE_URL` | `LLM_MODEL` | 说明 |
| :--- | :--- | :--- | :--- |
| **DeepSeek 官方** (推荐) | `https://api.deepseek.com` | `deepseek-chat` | 极高性价比、JSON 格式服从极佳 |
| **硅基流动 (SiliconFlow)** | `https://api.siliconflow.cn/v1` | `deepseek-ai/DeepSeek-V3` | 国内极速稳定直连 |
| **OpenAI 官方** | `https://api.openai.com/v1` | `gpt-4o-mini` | 国际稳定 |
| **OpenRouter** | `https://openrouter.ai/api/v1` | `deepseek/deepseek-chat` | 免翻中转聚合平台 |
| **阿里百炼 (Qwen)** | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen-plus` | 通义千问兼容端点 |

> [!TIP]
> **没有配 API Key 能用吗？**  
> 完全可以！寸序内建了 47 项严格单元测试的「确定性 NLU 规则引擎与切块算法」。在未配置 Key 时，查排期、记时长、切块防重叠、打卡、一键撤销等 90% 核心功能纯本地离线执行，毫不影响日常自律使用。

---

## 二、部署到个人服务器

寸序采用纯标准 Node.js ESM 编写，无繁杂编译构建环节，开箱即跑。

### 方案 1：Docker / Docker Compose 部署（推荐，适合 1Panel / 宝塔 / 命令行）

1. 克隆仓库并进入目录：
   ```bash
   git clone <你的仓库地址> inchi
   cd inchi
   ```
2. 复制并编辑配置文件：
   ```bash
   cp .env.example .env
   vim .env
   ```
3. 启动容器：
   ```bash
   docker compose up -d
   ```
4. 数据持久化：
   所有排期、任务进度、会话记录会自动持久化到 Docker volume `inchi-data`（映射在容器内 `/app/data`）。

---

### 方案 2：Node.js + PM2 部署（超轻量，内存仅占 ~30MB）

1. 安装 Node.js 18+ (推荐 Node 20 或 22) 与 PM2：
   ```bash
   npm install -g pm2
   ```
2. 拉取代码并配置环境：
   ```bash
   git clone <你的仓库地址> inchi
   cd inchi
   cp .env.example .env
   # 在 .env 中填入你的 TOKEN 和 LLM_API_KEY
   ```
3. 使用 PM2 启动服务：
   ```bash
   pm2 start server.mjs --name inchi
   pm2 save
   pm2 startup
   ```
4. 查看日志与状态：
   ```bash
   pm2 logs inchi
   pm2 status
   ```
   服务已在 `http://你的服务器IP:8792` 正常运行。数据自动保存在本地 `data/inchi_store.json`，即使服务器重启也不会丢失。

---

### 方案 3：Systemd 系统服务部署

创建 `/etc/systemd/system/inchi.service`：

```ini
[Unit]
Description=Inchi Personal Agent
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/var/www/inchi
ExecStart=/usr/bin/node server.mjs
Restart=always
RestartSec=5
EnvironmentFile=/var/www/inchi/.env

[Install]
WantedBy=multi-user.target
```

启动并设置开机自启：
```bash
systemctl daemon-reload
systemctl enable inchi
systemctl start inchi
```

---

## 三、配置 Nginx 反向代理与 SSL 证书

绑定你的专属域名（例如 `inchi.yourdomain.com`）：

```nginx
server {
    listen 80;
    server_name inchi.yourdomain.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name inchi.yourdomain.com;

    ssl_certificate /etc/letsencrypt/live/inchi.yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/inchi.yourdomain.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:8792;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

---

## 四、部署到 Cloudflare Pages（纯云端 Serverless）

若不想维护服务器，亦可直接使用免费的 Cloudflare Pages：

1. 在 Cloudflare 控制台新建 **Pages** 项目，连接 GitHub 仓库；
2. 构建命令留空，输出目录填根目录 `.`；
3. 新建 **D1** 数据库（命名为 `DB`），并执行仓库里的 `schema.sql`；
4. 在 Pages 项目设置中添加环境变量：
   - `ADMIN_TOKEN`: 你的专属密钥暗号
   - `LLM_API_KEY`: 你的大模型 Key
   - `LLM_BASE_URL`: API 地址
   - `LLM_MODEL`: 模型名称
5. 点击部署即可获得全球 Anycast 加速访问。
