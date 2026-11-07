FROM nginx:1.27-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY index.html holding.html retired-sw.js robots.txt sitemap.xml /usr/share/nginx/html/
COPY gyms/ /usr/share/nginx/html/gyms/
COPY instructors/ /usr/share/nginx/html/instructors/
COPY dibs/ /usr/share/nginx/html/dibs/
