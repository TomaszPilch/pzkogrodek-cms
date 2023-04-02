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
helm upgrade pzkogrodek-cms -n pzkogrodek devx/strapi-cms -f ./helm/values.yaml --set image.tag=$BITBUCKET_TAG
```
