FROM nginx:1.27-alpine

COPY docker/nginx/default.conf /etc/nginx/conf.d/default.conf
COPY index.html /usr/share/nginx/html/index.html
COPY observer.html /usr/share/nginx/html/observer.html
COPY script.js /usr/share/nginx/html/script.js
COPY observer.js /usr/share/nginx/html/observer.js
COPY style.css /usr/share/nginx/html/style.css
COPY assets /usr/share/nginx/html/assets
