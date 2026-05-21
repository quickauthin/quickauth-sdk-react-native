module.exports = {
  dependency: {
    platforms: {
      android: {
        sourceDir: './android',
        packageImportPath: 'import io.quickauth.rnsdk.QuickAuthRnSdkPackage;',
        packageInstance: 'new QuickAuthRnSdkPackage()',
      },
      ios: {
        podspecPath: './QuickAuthRnSdk.podspec',
      },
    },
  },
};
