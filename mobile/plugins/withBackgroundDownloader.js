const { withAppDelegate } = require('@expo/config-plugins');

/**
 * Expo config plugin to add handleEventsForBackgroundURLSession to iOS AppDelegate.
 * Required for @kesha-antonov/react-native-background-downloader to receive
 * download completion callbacks when the app has been backgrounded.
 *
 * Apply via app.json: "plugins": ["./plugins/withBackgroundDownloader"]
 * Then run: npx expo prebuild
 */
const withBackgroundDownloader = (config) => {
  return withAppDelegate(config, (mod) => {
    const { modResults } = mod;
    const contents = modResults.contents;

    // Idempotent: don't add if already present
    if (contents.includes('RNBackgroundDownloader')) {
      return mod;
    }

    // 1. Add import after the AppDelegate import
    modResults.contents = contents.replace(
      /#import "AppDelegate\.h"/,
      '#import "AppDelegate.h"\n#import <RNBackgroundDownloader/RNBackgroundDownloader.h>'
    );

    // 2. Inject handleEventsForBackgroundURLSession before didFinishLaunchingWithOptions
    modResults.contents = modResults.contents.replace(
      /- \(BOOL\)application:\(UIApplication \*\)application didFinishLaunchingWithOptions:/,
      `- (void)application:(UIApplication *)application
  handleEventsForBackgroundURLSession:(NSString *)identifier
  completionHandler:(void (^)(void))completionHandler {
  [RNBackgroundDownloader setCompletionHandlerWithIdentifier:identifier
                                           completionHandler:completionHandler];
}

- (BOOL)application:(UIApplication *)application didFinishLaunchingWithOptions:`
    );

    return mod;
  });
};

module.exports = withBackgroundDownloader;
