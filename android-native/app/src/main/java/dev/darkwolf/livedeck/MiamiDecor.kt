package dev.darkwolf.livedeck

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.BlendMode
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.CompositingStrategy
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.scale
import androidx.compose.ui.graphics.drawscope.translate
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.vector.PathParser
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.unit.dp

// Mêmes dessins que le décor Miami du panneau (palmiers : viewBox 260 × 300)
private val palmFronds = listOf(
    "M168 105 C 130 80, 90 85, 58 118 C 98 100, 132 100, 168 110 Z",
    "M168 105 C 140 60, 100 45, 70 58 C 110 62, 140 80, 166 110 Z",
    "M168 105 C 175 60, 200 38, 232 40 C 205 55, 186 78, 172 110 Z",
    "M168 105 C 205 85, 240 95, 258 128 C 230 108, 200 104, 170 112 Z",
    "M168 105 C 190 120, 205 150, 202 182 C 192 152, 180 132, 165 112 Z",
    "M168 105 C 145 120, 128 145, 126 172 C 140 148, 152 130, 170 112 Z",
    "M72 188 C 48 172, 22 176, 4 196 C 28 186, 50 186, 72 193 Z",
    "M72 188 C 60 160, 36 150, 16 156 C 42 162, 58 174, 70 193 Z",
    "M72 188 C 82 160, 104 148, 126 152 C 104 160, 88 174, 75 193 Z",
    "M72 188 C 98 178, 120 186, 132 206 C 112 194, 94 192, 74 194 Z",
    "M72 188 C 84 202, 90 220, 86 240 C 80 220, 74 206, 68 194 Z",
)
private val palmTrunks = listOf("M150 305 C 156 240, 142 170, 168 105" to 9f, "M62 305 C 66 265, 55 225, 72 188" to 6f)

/** Fond du mode Miami : lueurs, soleil rayé et palmiers en bas à droite. */
@Composable
fun MiamiBackdrop(modifier: Modifier = Modifier) {
    val dark = isSystemInDarkTheme()
    val fronds = remember { palmFronds.map { PathParser().parsePathString(it).toPath() } }
    val trunks = remember { palmTrunks.map { (d, w) -> PathParser().parsePathString(d).toPath() to w } }
    val palmColor = if (dark) Color(0xFF2A0F3A) else Color(0xFF4A1D4F)

    Box(modifier.fillMaxSize()) {
        // Lueurs rose (haut droite), cyan (bas gauche), violet (haut gauche)
        Canvas(Modifier.fillMaxSize()) {
            val w = size.width
            val h = size.height
            drawRect(Brush.radialGradient(listOf(Color(0xFFFF4FA0).copy(alpha = if (dark) .30f else .25f), Color.Transparent), Offset(w, 0f), w * .9f))
            drawRect(Brush.radialGradient(listOf(Color(0xFF26D6E6).copy(alpha = if (dark) .20f else .22f), Color.Transparent), Offset(0f, h), w * .8f))
            drawRect(Brush.radialGradient(listOf(Color(0xFF8C3CC8).copy(alpha = if (dark) .22f else .12f), Color.Transparent), Offset(w * .15f, 0f), w * .55f))
        }
        // Soleil rayé (les bandes sont découpées dans le disque)
        Canvas(Modifier.fillMaxSize().graphicsLayer { compositingStrategy = CompositingStrategy.Offscreen; alpha = if (dark) .24f else .2f }) {
            val d = 270.dp.toPx()
            val left = size.width - d + 40.dp.toPx()
            val top = size.height - d + 110.dp.toPx()
            drawCircle(
                Brush.verticalGradient(listOf(Color(0xFFFFD23F), Color(0xFFFF8A3D), Color(0xFFFF3C8C), Color(0xFFB5179E)), top, top + d),
                radius = d / 2, center = Offset(left + d / 2, top + d / 2),
            )
            listOf(.42f to .46f, .54f to .59f, .66f to .72f, .78f to .86f).forEach { (a, b) ->
                drawRect(Color.Black, Offset(left, top + d * a), Size(d, d * (b - a)), blendMode = BlendMode.Clear)
            }
        }
        // Palmiers en silhouette, liseré rose en sombre
        Canvas(Modifier.fillMaxSize().graphicsLayer { alpha = if (dark) .75f else .4f }) {
            val pw = 210.dp.toPx()
            val s = pw / 260f
            translate(size.width - pw - 14.dp.toPx(), size.height - 300f * s) {
                scale(s, s, pivot = Offset.Zero) {
                    if (dark) {
                        fronds.forEach { drawPath(it, Color(0xFFFF4FA0).copy(alpha = .8f), style = Stroke(2f)) }
                        trunks.forEach { (p, w) -> drawPath(p, Color(0xFFFF4FA0).copy(alpha = .8f), style = Stroke(w + 2f, cap = StrokeCap.Round)) }
                    }
                    trunks.forEach { (p, w) -> drawPath(p, palmColor, style = Stroke(w, cap = StrokeCap.Round)) }
                    fronds.forEach { drawPath(it, palmColor) }
                }
            }
        }
    }
}

/** Fin liseré néon en haut de l'écran. */
@Composable
fun NeonLine() {
    Box(
        Modifier.fillMaxWidth().height(3.dp)
            .background(Brush.horizontalGradient(listOf(Color(0xFFFF4FA0), Color(0xFFFF8A3D), Color(0xFF26D6E6)))),
    )
}

val NeonTitleBrush = Brush.horizontalGradient(listOf(Color(0xFFFF4FA0), Color(0xFFFF8A3D), Color(0xFF26D6E6)))
