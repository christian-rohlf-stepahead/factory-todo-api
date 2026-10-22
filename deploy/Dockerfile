FROM alpine/helm:3.14.4
WORKDIR /
COPY chart /chart
COPY deploy.sh /deploy.sh
RUN chmod +x /deploy.sh \
 && adduser -D -u 1001 deployer \
 && mkdir -p /tmp/helm/cache /tmp/helm/config /tmp/helm/data \
 && chown -R 1001:1001 /tmp/helm
ENV HELM_CACHE_HOME=/tmp/helm/cache \
    HELM_CONFIG_HOME=/tmp/helm/config \
    HELM_DATA_HOME=/tmp/helm/data
USER 1001
ENTRYPOINT []
