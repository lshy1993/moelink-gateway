# Genshin Gateway - nginx Docker 示例

快速启动：

```bash
# 在项目根目录运行：
docker-compose up --build

# 或者指定后端地址：
VITE_API_URL=http://api:3000 docker-compose up --build
```

说明：

Google Cloud 部署（Cloud Run）:

- 使用 Cloud Build 自动化部署：

	将 `docker/nginx/cloudbuild.yaml` 提交到 Cloud Build：

	```bash
	# 手动触发构建并部署 (替换 REGION 和 VITE_API_URL)
	gcloud builds submit --config docker/nginx/cloudbuild.yaml --substitutions=REGION=us-central1,VITE_API_URL=https://api.example.com
	```

注意：
- 部署前请确保 `gcloud` 已登录并设置了正确的 `PROJECT_ID`，并为 Cloud Build 和 Cloud Run 授予必要权限。
- 上述脚本和配置将把镜像推送到 `gcr.io/$PROJECT_ID/genshin-gateway`，并在 Cloud Run 上创建 `genshin-gateway` 服务，监听 `8080` 端口。
