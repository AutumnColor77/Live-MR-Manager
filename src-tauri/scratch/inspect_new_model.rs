use ort::session::Session;
use anyhow::Result;
use std::path::Path;

fn main() -> Result<()> {
    let model_path = Path::new(r"F:\Live-MR-Manager\src-tauri\models\model.onnx");
    if model_path.exists() {
        println!("\n[Inspect] Model: {:?}", model_path);
        let sess = Session::builder()?.commit_from_file(model_path)?;
        println!("  --- Inputs ---");
        for input in sess.inputs() {
            println!("  [In] {}: {:?}", input.name(), input.input_type());
        }
        println!("  --- Outputs ---");
        for output in sess.outputs() {
            println!("  [Out] {}: {:?}", output.name(), output.output_type());
        }
    } else {
        println!("Model not found at {:?}", model_path);
    }
    Ok(())
}
