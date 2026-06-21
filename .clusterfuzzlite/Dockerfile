FROM gcr.io/oss-fuzz-base/base-builder-javascript@sha256:7051327a33e495e34e563383c82dd944c77773ecebf20bd9cc94311574c0af2d

COPY . $SRC/egc
WORKDIR $SRC/egc
COPY .clusterfuzzlite/build.sh $SRC/
