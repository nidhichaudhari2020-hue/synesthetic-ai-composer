# Build the backend image first; pass its immutable registry digest as BASE_IMAGE.
ARG BASE_IMAGE
FROM ${BASE_IMAGE}
USER root
COPY --chown=10001:10001 models/composer.pt /models/composer.pt
RUN chmod 0400 /models/composer.pt
USER 10001:10001
