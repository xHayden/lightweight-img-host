module.exports = {
  purge: [
    './views/**/*.pug',
    './public/**/*.js',
  ],
  darkMode: false, // or 'media' or 'class'
  theme: {
    extend: {
      zIndex: {
       'hide': '-1',
      },
      height: {
        'w': "100vw"
      }
    }
  },
  variants: {
    extend: {},
  },
  plugins: [],
}
