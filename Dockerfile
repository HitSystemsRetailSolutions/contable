FROM node 

WORKDIR /usr/src

COPY ["package.json", "package-lock.json",  "/usr/src/"]

RUN npm install

COPY [".", "/usr/src/"]

EXPOSE 3039

CMD [ "npm", "start" ]
