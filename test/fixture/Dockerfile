FROM alpine:3.21
RUN apk add --no-cache openssh bash grep findutils coreutils sudo \
    && adduser -D -s /bin/sh tester \
    && echo 'tester:fixture-password' | chpasswd \
    && adduser -D -s /bin/sh nopass \
    && echo 'nopass:fixture-password' | chpasswd \
    && printf '%s\n' 'Defaults timestamp_timeout=0' 'tester ALL=(root) ALL' 'nopass ALL=(root) NOPASSWD: ALL' > /etc/sudoers.d/fixture
COPY entrypoint.sh /entrypoint.sh
RUN chmod 755 /entrypoint.sh
EXPOSE 22
ENTRYPOINT ["/entrypoint.sh"]
