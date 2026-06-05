FROM node:20-alpine AS builder
WORKDIR /app

# Accept build-time API URL (empty = relative URLs via nginx proxy)
ARG VITE_API_URL=""
ENV VITE_API_URL=$VITE_API_URL

COPY package*.json ./
RUN npm ci --silent
COPY . .
RUN npm run build

FROM nginx:alpine
COPY --from=builder /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY nginx-proxy-params.conf /etc/nginx/proxy_params.conf
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
