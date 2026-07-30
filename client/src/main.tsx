import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App'
import { LayerQuizPage } from './layerQuiz'

// 极简路由：/quiz 渲染独立的选型问卷页（方便直接分享链接），其余路径走主应用。
// 项目未引入路由库，问卷页也无需嵌套路由，按 pathname 分流即可。
const isQuizRoute = window.location.pathname.replace(/\/+$/, '') === '/quiz'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {isQuizRoute ? <LayerQuizPage /> : <App />}
  </StrictMode>,
)
