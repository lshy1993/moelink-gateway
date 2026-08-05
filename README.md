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

	将 `/cloudbuild.yaml` 提交到 Cloud Build：

	```bash
	# 手动触发构建并部署 (替换 REGION 和 VITE_API_URL)
	gcloud builds submit --config docker/nginx/cloudbuild.yaml --substitutions=REGION=us-central1,VITE_API_URL=https://api.example.com
	```

注意：
- 部署前请确保 `gcloud` 已登录并设置了正确的 `PROJECT_ID`，并为 Cloud Build 和 Cloud Run 授予必要权限。
- 上述脚本和配置将把镜像推送到 `gcr.io/$PROJECT_ID/genshin-gateway`，并在 Cloud Run 上创建 `genshin-gateway` 服务，监听 `8080` 端口。

本地 NAS 部署注意事项（后端容器已存在）：

- 如果你的后端容器已经运行在宿主机上并且你希望通过容器名互联，先创建一个用户自定义网络：

	```bash
	docker network create gateway_net
	```

- 启动或重新启动后端容器并加入该网络（假设容器名为 `genshin-backend` 且监听 8091）：

	```bash
	docker run -d --name genshin-backend --network gateway_net -e PORT=8091 your-backend-image:latest
	```

- 然后在本仓库根目录运行：

	```bash
	docker-compose up --build
	```

- 另一种替代：如果无法使用自定义网络，可以在 `docker-compose` 启动时通过环境变量直接指定后端可访问的地址：

	```bash
	VITE_API_URL=http://<backend-host-or-ip>:8091 docker-compose up --build
	```

