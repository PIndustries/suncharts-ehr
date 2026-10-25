use std::{env, fs, path::Path};

fn append(archive: &mut tar::Builder<flate2::write::GzEncoder<fs::File>>, path: &Path) {
    let name = path.file_name().and_then(|s| s.to_str()).unwrap_or("");
    if matches!(name, ".git" | "target" | "node_modules" | "__pycache__")
        || (name.starts_with(".env") && name != ".env.example")
        || path.extension().is_some_and(|s| {
            matches!(
                s.to_str(),
                Some(
                    "pyc"
                        | "log"
                        | "db"
                        | "sqlite"
                        | "sqlite3"
                        | "pem"
                        | "key"
                        | "p12"
                        | "pfx"
                        | "p8"
                )
            )
        })
        || path.is_symlink()
    {
        return;
    }
    if path.is_dir() {
        let mut entries = fs::read_dir(path)
            .unwrap()
            .map(|e| e.unwrap().path())
            .collect::<Vec<_>>();
        entries.sort();
        for child in entries {
            append(archive, &child);
        }
    } else {
        archive
            .append_path_with_name(path, Path::new("suncharts-ehr").join(path))
            .unwrap();
    }
}

fn main() {
    // Only explicitly selected source paths enter the public source offer.
    // Never include .env, target/, .git/, credentials or patient data.
    let output = Path::new(&env::var("OUT_DIR").unwrap()).join("source.tar.gz");
    let encoder = flate2::write::GzEncoder::new(
        fs::File::create(output).unwrap(),
        flate2::Compression::default(),
    );
    let mut archive = tar::Builder::new(encoder);
    for name in [
        "src",
        "web",
        "scripts",
        "migrations",
        "tests",
        "api",
        "docs",
        ".github",
        "Cargo.toml",
        "Cargo.lock",
        "build.rs",
        "LICENSE",
        "README.md",
        "AGENTS.md",
        "CONTRIBUTING.md",
        "SECURITY.md",
        ".env.example",
        ".gitignore",
    ] {
        println!("cargo:rerun-if-changed={name}");
        let path = Path::new(name);
        if path.exists() {
            append(&mut archive, path);
        }
    }
    archive.into_inner().unwrap().finish().unwrap();
}
