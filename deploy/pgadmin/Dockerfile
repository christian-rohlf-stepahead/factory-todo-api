
FROM dpage/pgadmin4:8.12

# The upstream image grants /venv/bin/python3 the cap_net_bind_service file
# capability, so pgAdmin can bind a privileged port as a non-root user. We
# always listen above 1024 (see pgadmin-deployment.yaml), so that capability
# is unused here, but its mere presence makes the kernel refuse to exec the
# binary at all under Kubernetes' restricted profile (allowPrivilegeEscalation:
# false sets no_new_privs, and execve() of a file with capabilities under
# no_new_privs fails with EPERM) -- that's what crashes the pod. Strip it.
USER root
RUN apt-get update \
 && apt-get install -y --no-install-recommends libcap2-bin \
 && (getcap -r / 2>/dev/null | cut -d' ' -f1 | xargs -r -n1 setcap -r) \
 && apt-get purge -y --auto-remove libcap2-bin \
 && rm -rf /var/lib/apt/lists/*
USER 1001:0
