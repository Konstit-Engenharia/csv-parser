FROM ubuntu:24.04

RUN apt-get update
RUN apt-get upgrade -y
RUN DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    ca-certificates \
    clang \
    cmake \
    git \
    ninja-build

RUN apt-get clean
RUN rm -rf /var/lib/apt/lists/*

WORKDIR /work
