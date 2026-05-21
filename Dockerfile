FROM almalinux:9

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

# ── System deps: build tools + Java 21 ───────────────────────────────────────
RUN dnf update -y \
    && dnf install -y --setopt=install_weak_deps=False epel-release \
    && dnf install -y --setopt=install_weak_deps=False \
        gcc make bison flex automake autoconf libtool \
        gettext gettext-devel diffutils \
        java-21-openjdk-devel \
        git \
    && dnf clean all && rm -rf /var/cache/dnf

# ── Node.js 20 LTS ───────────────────────────────────────────────────────────
RUN curl -fsSL https://rpm.nodesource.com/setup_20.x | bash - \
    && dnf install -y nodejs \
    && dnf clean all && rm -rf /var/cache/dnf

# ── Build cobj (COBOL → Java compiler) from source ───────────────────────────
WORKDIR /build
COPY opensourcecobol4j/ .
RUN chmod +x configure libcobj/gradlew \
    && ./configure --prefix=/usr/ \
    && make \
    && make -C lib install \
    && make -C cobj install \
    && make -C bin install \
    && make -C config install \
    && make -C copy install \
    && mkdir -p /usr/lib/opensourcecobol4j \
    && find /build/libcobj/app/build/libs -name "*.jar" | head -1 \
       | xargs -I{} cp {} /usr/lib/opensourcecobol4j/libcobj.jar

# libcobj.jar goes to /usr/lib/opensourcecobol4j/libcobj.jar after make install
ENV CLASSPATH=:/usr/lib/opensourcecobol4j/libcobj.jar

# ── Web app (preserve structure so server.js finds ../cobol_repo_scanner.sh) ─
COPY opensourcecobol4j/tools/ /app/tools/
WORKDIR /app/tools/web-ui
RUN npm install

# Mount point for local COBOL source files
VOLUME ["/cobol-source"]

EXPOSE 3000
CMD ["node", "server.js"]
