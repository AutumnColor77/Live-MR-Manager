use ort::session::Session;
use anyhow::Result;
use std::path::Path;

fn main() -> Result<()> {
    let models_dir = Path::new(r"F:\Live-MR-Manager\src-tauri\models");
    let test_models = vec![
        "decoder_model.onnx",
        "decoder_model_fp16.onnx",
        "decoder_model_merged.onnx",
        "decoder_model_merged_q4.onnx"
    ];

    for model_name in test_models {
        let p = models_dir.join(model_name);
        if p.exists() {
            println!("\n[Inspect] Model: {}", model_name);
            let sess = Session::builder()?.commit_from_file(&p)?;
            println!("  --- Inputs ---");
            for input in sess.inputs() {
                println!("  [In] {}: {:?}", input.name(), input.input_type());
            }
            println!("  --- Outputs ---");
            for output in sess.outputs() {
                println!("  [Out] {}: {:?}", output.name(), output.output_type());
            }
        }
    }
    Ok(())
}
