# syntax=docker/dockerfile:1

# The site is hand-written static files, so there is no build stage — nothing to
# compile, no dependencies to install, and no workspace packages to resolve. The
# image is nginx with site/ copied in.
#
# The build context is the REPO ROOT (Dockerfile path apps/website/Dockerfile),
# matching how the other sites on this Dokploy are set up, so the paths below are
# repo-relative. The root .dockerignore is what keeps that context small.
FROM nginx:alpine

COPY apps/website/site /usr/share/nginx/html
COPY apps/website/nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
