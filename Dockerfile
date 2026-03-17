FROM node:20-slim

# LibreOffice Writer (DOCX → PDF dönüşümü için)
RUN apt-get update && apt-get install -y \
    libreoffice-writer \
    --no-install-recommends \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .
RUN npm run build

EXPOSE 4000
CMD ["node", "dist/main.js"]
