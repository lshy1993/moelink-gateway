#!/bin/sh
set -e

# Substitute only VITE_API_URL in the template and write real config
envsubst '${VITE_API_URL}' < /etc/nginx/conf.d/default.conf.template > /etc/nginx/conf.d/default.conf

exec nginx -g 'daemon off;'
