const path = require('path');
const RemoveWebpackPlugin = require('remove-files-webpack-plugin');
const HtmlWebpackPlugin = require('html-webpack-plugin');
module.exports = {
  mode: 'production',
  devtool: 'inline-source-map',
  entry: path.join(__dirname, 'index.js'),
  output: {
    filename: 'bundle.js',
    path: path.join(__dirname, 'dist'),
  },
  resolve: {
    extensions: ['.js'],
  },
  module: {
    rules: [{ test: /\.css$/, use: ['style-loader', 'css-loader'] }],
  },
  plugins: [
    new HtmlWebpackPlugin({
      inject: false,
      templateContent: ({ htmlWebpackPlugin, compilation }) => `<!DOCTYPE html>
<html lang="en">

<head>
    <style>
        /* The colors are hard-coded and based on the \`editor.background\` and \`editor.foreground\` values from \`./arduino-ide-extension/src/browser/data/default.color-theme.json\` */
        @media (prefers-color-scheme: light) {
            html {
                background: #ffffff;
                color: #4e5b61;
            }
        }

        /* The colors are hard-coded and based on the \`editor.background\` and \`editor.foreground\` values from \`./arduino-ide-extension/src/browser/data/dark.color-theme.json\` */
        @media (prefers-color-scheme: dark) {
            html {
                background: #1f272a;
                color: #dae3e3;
            }
        }

        .theia-preload {
            position: absolute;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;

            /* Above styles copied from https://github.com/eclipse-theia/theia/blob/5aeef6c0c683b4e91713ab736957e6655b486adc/packages/core/src/browser/style/index.css#L147-L161 */
            /* Otherwise, there is a flickering when Theia's CSS loads. */

            background-image: none;
        }

        .theia-preload::after {
            /* remove default loading animation */
            content: none;
        }

        .spinner-container {
            display: flex;
            flex-direction: center;
            align-self: center;
            justify-content: center;
            height: 100vh;
            width: 100vw;
        }

        .custom-spinner {
            align-self: center;
        }
    </style>
</head>

<body>
    <div class='spinner-container'>
        <div class='custom-spinner'>
            <lottie-player autoplay loop mode="normal" style="width:320px;height:320px">
            </lottie-player>
        </div>
    </div>
    ${htmlWebpackPlugin.files.js.map(
      (jsFile) => `<script>
    ${compilation.assets[
      jsFile.substr(htmlWebpackPlugin.files.publicPath.length)
    ].source()}
  </script>`
    )}
</body>

</html>
`,
      filename: path.join(__dirname, '../electron-app/resources/preload.html'),
    }),
    new RemoveWebpackPlugin({
      after: {
        include: [path.join(__dirname, './dist')],
      },
    }),
  ],
};
