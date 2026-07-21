FROM ubuntu:24.04

RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    ca-certificates \
    clang \
    cmake \
    git \
    ninja-build \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /work
