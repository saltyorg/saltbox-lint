FROM emscripten/emsdk:3.1.61

WORKDIR /build

# Download and build Oniguruma from release tarball
RUN curl -sL https://github.com/kkos/oniguruma/releases/download/v6.9.10/onig-6.9.10.tar.gz | tar xz \
    && cd onig-6.9.10 \
    && emconfigure ./configure --enable-posix-api=no --disable-shared \
    && emmake make

# Copy our scanner wrapper and compile to WASM
COPY onig_scanner.c .

RUN emcc -O2 \
    -s STANDALONE_WASM=1 \
    --no-entry \
    -s 'EXPORTED_FUNCTIONS=["_onig_scanner_init","_create_onig_scanner","_find_next_match","_free_onig_scanner","_get_last_onig_error","_malloc","_free","__initialize"]' \
    -s ALLOW_MEMORY_GROWTH=1 \
    -Ionig-6.9.10/src \
    onig_scanner.c \
    onig-6.9.10/src/.libs/libonig.a \
    -o onig.wasm
