FROM nginx:1.27-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY index.html /usr/share/nginx/html/index.html
COPY gyms/ /usr/share/nginx/html/gyms/
COPY instructors/ /usr/share/nginx/html/instructors/
COPY dibs/ /usr/share/nginx/html/dibs/
