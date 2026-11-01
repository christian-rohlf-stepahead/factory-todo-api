FROM dpage/pgadmin4:8

# The restricted Pod Security profile forbids privilege escalation, which
# blocks exec of any capability-bearing binary outright (not just root/sudo
# use of it). Strip the capability dpage/pgadmin4 sets on its bundled
# python3 (normally so it can bind to port 80 as non-root) at build time,
# as root, since the pod will never run as root to grant it at runtime.
USER root
RUN (command -v setcap >/dev/null 2>&1 || (apt-get update \
      && apt-get install -y --no-install-recommends libcap2-bin \
      && rm -rf /var/lib/apt/lists/*)) \
 && setcap -r /venv/bin/python3

USER 5050
