# 自建部署

本连接器零第三方依赖，只需要 Node.js ≥ 20。

## 1. 直接运行

```bash
git clone https://github.com/fattank/chs-drg-mcp.git
cd chs-drg-mcp

DRG_API_BASE=http://127.0.0.1:4173 \
MCP_HOST=0.0.0.0 \
MCP_PORT=4174 \
node mcp-server.mjs
```

启动后：

| 地址 | 用途 |
| --- | --- |
| `http://<host>:4174/mcp` | Streamable HTTP |
| `http://<host>:4174/sse` | HTTP+SSE |
| `http://<host>:4174/health` | 健康检查 |

## 2. systemd 常驻

复制并修改 [`deploy/chs-drg-mcp.service`](../deploy/chs-drg-mcp.service)：

```bash
sudo cp deploy/chs-drg-mcp.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now chs-drg-mcp
sudo systemctl status chs-drg-mcp
```

修改后重载：

```bash
sudo systemctl restart chs-drg-mcp
```

## 3. HTTPS（推荐，生产/上架必需）

MCP 平台通常要求 HTTPS。使用 Nginx 终止 TLS，示例见 [`deploy/nginx-https.conf.example`](../deploy/nginx-https.conf.example)：

```bash
sudo cp deploy/nginx-https.conf.example /etc/nginx/conf.d/chs-drg-mcp.conf
# 替换域名与证书路径
sudo nginx -t && sudo systemctl reload nginx
```

获取免费证书：

- 阿里云/腾讯云控制台申请免费 DV 证书；
- 或 `certbot --nginx -d your-domain.com`。

> **中国大陆备案提醒**：如果服务器在中国大陆，域名解析到该服务器并使用 80/443，按工信部要求需要完成 ICP 备案。否则可考虑非标准端口、境外/香港入口或 CDN 终止 TLS。

### 直接 TLS（可选）

不想用 Nginx 时，可直接让连接器监听 HTTPS：

```bash
TLS_CERT=/path/fullchain.pem TLS_KEY=/path/privkey.pem MCP_PORT=443 node mcp-server.mjs
```

## 4. 鉴权

公开部署建议开启令牌：

```bash
DRG_MCP_AUTH_TOKEN=$(openssl rand -hex 32) node mcp-server.mjs
```

客户端请求需带 `Authorization: Bearer <token>`。MCP 平台侧如支持 API Key 认证，Header Name 填 `Authorization`、值填 `Bearer <token>` 即可。

## 5. 反向代理要点

SSE 是长连接，反向代理必须：

- 关闭缓冲：`proxy_buffering off;`
- 拉长超时：`proxy_read_timeout 3600s;`
- 不要改写 `Accept-Encoding`：`proxy_set_header Accept-Encoding "";`

## 6. 验证

```bash
curl -s http://127.0.0.1:4174/health

curl -s -X POST http://127.0.0.1:4174/mcp \
  -H 'Content-Type: application/json' -H 'Accept: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' | head -c 400
```
