
FROM dpage/pgadmin4:8.12

# The upstream image grants /venv/bin/python3 the cap_net_bind_service file
# capability, so pgAdmin can bind a privileged port as a non-root user. We
# always listen above 1024 (see pgadmin-deployment.yaml), so that capability
# is unused here, but its mere presence makes the kernel refuse to exec the
# binary at all under Kubernetes' restricted profile (allowPrivilegeEscalation:
# false sets no_new_privs, and execve() of a file with capabilities under
# no_new_privs fails with EPERM) -- that's what crashes the pod. Strip it.
#
# The base image has no apt/dnf (no "apt-get", confirmed by a failed build),
# so do this with the python3 interpreter the image already ships, walking
# the filesystem and removing the "security.capability" xattr wherever it's
# set, rather than depending on a setcap/libcap package that may not exist.
USER root
RUN printf '%s\n' \
  "import os" \
  "skip = {'/proc', '/sys', '/dev'}" \
  "for root, dirs, files in os.walk('/'):" \
  "    dirs[:] = [d for d in dirs if os.path.join(root, d) not in skip]" \
  "    for name in files:" \
  "        path = os.path.join(root, name)" \
  "        try:" \
  "            os.removexattr(path, 'security.capability')" \
  "        except OSError:" \
  "            pass" \
  > /tmp/strip_caps.py \
 && /venv/bin/python3 /tmp/strip_caps.py \
 && rm /tmp/strip_caps.py
USER 1001:0
