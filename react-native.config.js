module.exports = {
  dependency: {
    platforms: {
      android: {
        sourceDir: './android',
        packageImportPath: 'import io.quickauth.rnsdk.QuickAuthRnSdkPackage;',
        packageInstance: 'new QuickAuthRnSdkPackage()',
      },
      ios: {
        podspecPath: require('path').join(__dirname, 'QuickAuthRnSdk.podspec'),
      },
    },
  },
};
