FROM public.ecr.aws/lambda/nodejs:22

# Install MySQL-compatible dump client and gzip.
RUN dnf install -y mariadb105 gzip \
    && dnf clean all \
    && rm -rf /var/cache/dnf

# Normalize the executable name used by the Node application.
RUN if command -v mariadb-dump >/dev/null 2>&1; then \
      ln -sf "$(command -v mariadb-dump)" /usr/local/bin/mysqldump; \
    elif command -v mysqldump >/dev/null 2>&1; then \
      ln -sf "$(command -v mysqldump)" /usr/local/bin/mysqldump; \
    else \
      echo "No mysqldump-compatible executable found" && exit 1; \
    fi

COPY package*.json ${LAMBDA_TASK_ROOT}/
RUN npm install --omit=dev

COPY index.js ${LAMBDA_TASK_ROOT}/

CMD ["index.handler"]
