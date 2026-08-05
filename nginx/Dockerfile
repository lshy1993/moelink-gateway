FROM nginx:stable-alpine

RUN apk add --no-cache gettext

COPY default.conf.template /etc/nginx/conf.d/
COPY docker-entrypoint.sh /docker-entrypoint.sh
COPY html /usr/share/nginx/html

RUN chmod +x /docker-entrypoint.sh

ENTRYPOINT ["/docker-entrypoint.sh"]
