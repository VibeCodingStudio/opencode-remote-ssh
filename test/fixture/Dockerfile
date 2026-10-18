FROM alpine:3.21
RUN apk add --no-cache openssh bash grep findutils coreutils \
    && adduser -D -s /bin/sh tester \
    && echo 'tester:fixture-password' | chpasswd
COPY entrypoint.sh /entrypoint.sh
RUN chmod 755 /entrypoint.sh
EXPOSE 22
ENTRYPOINT ["/entrypoint.sh"]
