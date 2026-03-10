/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './views/**/*.pug',
    './public/**/*.js',
  ],
  theme: {
    extend: {
      zIndex: {
        'hide': '-1',
      },
      height: {
        'w': '100vw',
      },
    },
  },
  plugins: [],
}
