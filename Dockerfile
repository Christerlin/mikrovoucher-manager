# Image de production. Le service tourne en processus permanent : c'est ce que
# demandent la boucle de réconciliation (toutes les 2 min) et les compteurs
# anti-abus, qui vivent en mémoire.
FROM node:22-alpine

WORKDIR /app

# Les dépendances d'abord : cette couche ne se reconstruit que si
# package-lock.json bouge, pas à chaque changement de code.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

# Pas de npm au démarrage : npm resterait entre le superviseur et node, et
# avalerait les signaux d'arrêt.
CMD ["node", "src/server.js"]
