# Non-root nginx (uid 101) serving the site on port 8080
FROM nginxinc/nginx-unprivileged:1.30-alpine
COPY --chown=101:101 . /usr/share/nginx/html
