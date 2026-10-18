#!/bin/sh
set -eu
ssh-keygen -A
mkdir -p /home/tester/.ssh
cp /keys/authorized_keys /home/tester/.ssh/authorized_keys
chmod 700 /home/tester/.ssh
chmod 600 /home/tester/.ssh/authorized_keys
chown -R tester:tester /home/tester
cat >/etc/ssh/sshd_config <<'EOF'
Port 22
HostKey /etc/ssh/ssh_host_ed25519_key
HostKey /etc/ssh/ssh_host_rsa_key
PasswordAuthentication yes
PubkeyAuthentication yes
KbdInteractiveAuthentication yes
PermitRootLogin no
AllowTcpForwarding yes
UsePAM no
PrintMotd no
LogLevel ERROR
EOF
if [ "${NO_SFTP:-0}" != 1 ]; then
  echo 'Subsystem sftp internal-sftp' >>/etc/ssh/sshd_config
fi
exec /usr/sbin/sshd -D -e
