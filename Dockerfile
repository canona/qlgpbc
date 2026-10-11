FROM node:20-slim

# poppler-utils cung cấp pdftotext / pdfinfo / pdftoppm cho trích xuất PDF
RUN apt-get update \
  && apt-get install -y --no-install-recommends poppler-utils ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
# Ứng dụng không dùng thư viện ngoài nên không có bước npm install phụ thuộc.
COPY server.js ./server.js
COPY lib ./lib
COPY public ./public

ENV NODE_ENV=production
ENV PORT=3000
ENV DATA_DIR=/app/data

# Chạy bằng user node có sẵn trong image (không chạy root)
RUN mkdir -p /app/data && chown -R node:node /app
USER node

EXPOSE 3000
VOLUME ["/app/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
