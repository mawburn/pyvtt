import resolve, { nodeResolve } from '@rollup/plugin-node-resolve'
import babel from '@rollup/plugin-babel'
import commonjs from '@rollup/plugin-commonjs'
import postcss from 'rollup-plugin-postcss'
import autoprefixer from 'autoprefixer'
import builtins from 'rollup-plugin-node-builtins'
import globals from 'rollup-plugin-node-globals'
import { terser } from 'rollup-plugin-terser'

export default {
  input: 'js/index.js',
  output: {
    file: 'build/bundle.js',
    format: 'iife',
  },
  plugins: [
    nodeResolve({ preferBuiltins: false, extensions: ['.css'] }),
    commonjs(),
    globals(),
    builtins(),
    babel({ babelHelpers: 'bundled' }),
    postcss({
      modules: true,
      minimize: true,
      plugins: [autoprefixer()],
    }),
    resolve({
      browser: true,
    }),
    terser(),
  ],
}
