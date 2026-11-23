import java.util.Properties
import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}

// Secrets : keystore.properties (jamais commité) en local, variables d'environnement sur GitHub
val localProps = Properties().apply {
    val f = rootProject.file("keystore.properties")
    if (f.exists()) f.inputStream().use { load(it) }
}
fun secret(key: String, env: String): String? = localProps.getProperty(key) ?: System.getenv(env)?.takeIf { it.isNotEmpty() }

android {
    namespace = "dev.darkwolf.livedeck"
    compileSdk = 36

    defaultConfig {
        applicationId = "dev.darkwolf.livedeck"
        minSdk = 26
        targetSdk = 36
        // Numéro de version : fourni par la compilation GitHub
        versionCode = (System.getenv("APP_VERSION_CODE") ?: "1").toInt()
        versionName = System.getenv("APP_VERSION_NAME") ?: "2.0-dev"
        buildConfigField("String", "PANEL_URL", "\"https://tw.darkwolf-bots.com\"")
        // Jeton de service Cloudflare Access : laisse l'appli passer la protection du panneau
        buildConfigField("String", "CF_ACCESS_ID", "\"${secret("cfAccessId", "CF_ACCESS_CLIENT_ID") ?: ""}\"")
        buildConfigField("String", "CF_ACCESS_SECRET", "\"${secret("cfAccessSecret", "CF_ACCESS_CLIENT_SECRET") ?: ""}\"")
    }

    signingConfigs {
        create("release") {
            secret("storeFile", "ANDROID_KEYSTORE_FILE")?.let { store ->
                storeFile = file(store)
                storePassword = secret("storePassword", "ANDROID_KEYSTORE_PASSWORD")
                keyAlias = secret("keyAlias", "ANDROID_KEY_ALIAS") ?: "twitchdeck"
                keyPassword = secret("keyPassword", "ANDROID_KEYSTORE_PASSWORD")
            }
        }
    }
    buildTypes {
        release {
            isMinifyEnabled = false
            if (secret("storeFile", "ANDROID_KEYSTORE_FILE") != null) signingConfig = signingConfigs.getByName("release")
        }
    }
    buildFeatures {
        compose = true
        buildConfig = true
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

kotlin {
    compilerOptions { jvmTarget.set(JvmTarget.JVM_17) }
}

dependencies {
    val composeBom = platform("androidx.compose:compose-bom:2025.06.00")
    implementation(composeBom)
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.activity:activity-compose:1.10.1")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.9.1")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.9.1")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.10.2")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("io.coil-kt.coil3:coil-compose:3.2.0")
    implementation("io.coil-kt.coil3:coil-network-okhttp:3.2.0")
}
