# PZKO Grodek CMS

### `develop`

```
yarn develop
```

### `start`

```
yarn start
```

### `build`

```
yarn build
```

### HELM deploy

```
helm upgrade pzkogrodek-cms-new -n pzkogrodek devx/strapi-cms -f ./helm/values.yaml --set image.tag=$BITBUCKET_TAG
```

```
helm upgrade -n pzkogrodek pzko-postgresql bitnami/postgresql -f ./helm/postgresql-values.yaml --version 12.2.6
```
